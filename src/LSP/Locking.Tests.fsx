#load "Locking.fs"

open System
open System.Collections.Generic
open System.Threading
open LSP.Locking

let assertEqual expected actual message =
    if expected <> actual then
        failwith $"{message}: expected {expected}, got {actual}"

let timestamps (values: int64 seq) =
    let remaining = Queue<int64>(values)
    fun () -> remaining.Dequeue()

let stateLock = new ReaderWriterLockSlim()

let testTiming = createRequestExecutionTiming ()
let result =
    runTracedReadLocked
        stateLock
        (Some 100)
        CancellationToken.None
        (fun () -> 0L)
        testTiming
        (async {
            do! Async.Sleep 25
            return 42
        })

match result with
| Acquired 42 -> ()
| other -> failwith $"unexpected read result: {other}"

if stateLock.CurrentReadCount <> 0 then
    failwith "read lock leaked after an async yield"

if not (stateLock.TryEnterWriteLock(100)) then
    failwith "writer remained blocked after read workflow completed"

stateLock.ExitWriteLock()

// Exercise the real TryEnter timeout path while another thread owns the writer.
let timeoutLock = new ReaderWriterLockSlim()
let writerReady = new ManualResetEventSlim(false)
let releaseWriter = new ManualResetEventSlim(false)
let writer =
    Thread(fun () ->
        timeoutLock.EnterWriteLock()
        try
            writerReady.Set()
            releaseWriter.Wait()
        finally
            timeoutLock.ExitWriteLock())
writer.Start()
if not (writerReady.Wait(1000)) then failwith "timeout writer did not acquire the lock"

let realTimeoutTiming = createRequestExecutionTiming ()
try
    let realTimeout =
        runTracedReadLocked
            timeoutLock
            (Some 25)
            CancellationToken.None
            (fun () -> DateTime.UtcNow.Ticks)
            realTimeoutTiming
            (async { return 99 })

    assertEqual TimedOut realTimeout "real TryEnter timeout result"
    assertEqual (Some false) realTimeoutTiming.lockAcquired "real TryEnter timeout acquisition state"
    assertEqual None realTimeoutTiming.methodStartAt "real TryEnter timeout method start"
finally
    releaseWriter.Set()
    if not (writer.Join(1000)) then failwith "timeout writer did not exit"

// Success uses one boundary timestamp for lock completion and method start.
let successTiming = createRequestExecutionTiming ()
let successResult =
    runTracedReadLocked
        stateLock
        None
        CancellationToken.None
        (timestamps [ 20L; 35L ])
        successTiming
        (async { return 7 })

assertEqual (Acquired 7) successResult "traced success result"
assertEqual (Some 20L) successTiming.lockWaitEndAt "success lock completion"
assertEqual (Some 20L) successTiming.methodStartAt "success method start"
assertEqual (Some 35L) successTiming.methodEndAt "success method end"
let successSegments = requestExecutionSegments (fun startTime endTime -> endTime - startTime) successTiming
assertEqual (Some 15L) successSegments.methodDuration "success method duration"
assertEqual None successSegments.fallbackDuration "success fallback duration"

// Timeout fallback is separate and leaves handler time empty.
let timeoutTiming = createRequestExecutionTiming ()
markLockTimedOut 40L timeoutTiming
startFallback 41L timeoutTiming
closeFallback 48L timeoutTiming
let timeoutSegments = requestExecutionSegments (fun startTime endTime -> endTime - startTime) timeoutTiming
assertEqual (Some false) timeoutTiming.lockAcquired "timeout acquisition state"
assertEqual None timeoutSegments.methodDuration "timeout method duration"
assertEqual (Some 7L) timeoutSegments.fallbackDuration "timeout fallback duration"

let assertAcquiredFailureClosesMethod name expectedException workflow =
    use failureLock = new ReaderWriterLockSlim()
    let timing = createRequestExecutionTiming ()
    let mutable caught = false
    try
        runTracedReadLocked
            failureLock
            None
            CancellationToken.None
            (timestamps [ 50L; 63L ])
            timing
            workflow
        |> ignore
    with error when expectedException error ->
        caught <- true

    if not caught then failwith $"{name}: expected failure was not observed"
    assertEqual (Some true) timing.lockAcquired $"{name} acquisition state"
    assertEqual (Some 50L) timing.lockWaitEndAt $"{name} lock completion"
    assertEqual (Some 50L) timing.methodStartAt $"{name} method start"
    assertEqual (Some 63L) timing.methodEndAt $"{name} method closure"
    markLockTimedOut 999L timing
    assertEqual (Some true) timing.lockAcquired $"{name} timeout overwrite"
    assertEqual (Some 50L) timing.lockWaitEndAt $"{name} lock overwrite"
    assertEqual 0 failureLock.CurrentReadCount $"{name} lock release"

assertAcquiredFailureClosesMethod
    "acquired cancellation"
    (fun error -> error :? OperationCanceledException)
    (async { return raise (OperationCanceledException("cancelled")) })

assertAcquiredFailureClosesMethod
    "acquired exception"
    (fun error -> error :? InvalidOperationException)
    (async { return raise (InvalidOperationException("boom")) })

printfn "LSP lock and request timing regression tests passed"
