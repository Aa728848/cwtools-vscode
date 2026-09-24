#load "../TestHelpers.fsx"
#load "Locking.fs"

open System
open System.Collections.Generic
open System.Threading
open LSP.Locking
open TestHelpers

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

// A writer that parks in the waiting state blocks every new reader. Bulk model
// validation keeps the root read lock for seconds, so a parked writer turned that
// hold into a total freeze of hover/completion/semantic tokens. Polling acquisition
// must therefore keep readers working while it waits.
let startReadHold (target: ReaderWriterLockSlim) (holdMs: int) =
    let entered = new ManualResetEventSlim(false)
    let reader =
        Thread(fun () ->
            target.EnterReadLock()
            try
                entered.Set()
                Thread.Sleep holdMs
            finally
                target.ExitReadLock())
    reader.IsBackground <- true
    reader.Start()
    if not (entered.Wait(2000)) then failwith "long read holder did not enter"
    reader

let measureReadWait (target: ReaderWriterLockSlim) =
    let wait = Diagnostics.Stopwatch.StartNew()
    let acquired = target.TryEnterReadLock(500)
    wait.Stop()
    if acquired then target.ExitReadLock()
    acquired, wait.ElapsedMilliseconds

// Hazard being fixed: a parked writer blocks readers for the whole wait.
let parkedLock = new ReaderWriterLockSlim()
let parkedReader = startReadHold parkedLock 1500
let parkedWriter =
    Thread(fun () ->
        parkedLock.EnterWriteLock()
        parkedLock.ExitWriteLock())
parkedWriter.IsBackground <- true
parkedWriter.Start()
Thread.Sleep 100
let parkedReadAcquired, parkedReadWaitMs = measureReadWait parkedLock
check (not parkedReadAcquired)
      $"a parked writer must block concurrent readers (waited {parkedReadWaitMs}ms)"
parkedReader.Join()
parkedWriter.Join()

// Fixed behaviour: a polling writer leaves readers unblocked while it waits.
let pollingLock = new ReaderWriterLockSlim()
let pollingReader = startReadHold pollingLock 800
let mutable pollingAcquired = true
let poller =
    Thread(fun () -> pollingAcquired <- tryAcquireWriteLockPolling pollingLock 400 1)
poller.IsBackground <- true
poller.Start()
Thread.Sleep 100
let polledReadAcquired, polledReadWaitMs = measureReadWait pollingLock
check polledReadAcquired "readers must still be served while a writer polls"
check (polledReadWaitMs < 200L)
      $"a polling writer must not make readers wait (observed {polledReadWaitMs}ms)"
poller.Join()
check (not pollingAcquired) "polling must report the expired budget instead of acquiring"
pollingReader.Join()

// The poller still wins the lock once the reader releases inside its budget.
let handoffLock = new ReaderWriterLockSlim()
let handoffReader = startReadHold handoffLock 300
let mutable handoffAcquired = false
let handoff =
    Thread(fun () ->
        // ReaderWriterLockSlim ownership is thread-affine: the acquiring thread releases.
        handoffAcquired <- tryAcquireWriteLockPolling handoffLock 3000 1
        if handoffAcquired then handoffLock.ExitWriteLock())
handoff.IsBackground <- true
handoff.Start()
handoffReader.Join()
handoff.Join()
check handoffAcquired "polling must acquire the writer once readers release within the budget"

// A queued writer owns the next grant: polling must not overtake it.
let queueLock = new ReaderWriterLockSlim()
let queueReader = startReadHold queueLock 500
let queuedWriter =
    Thread(fun () ->
        queueLock.EnterWriteLock()
        queueLock.ExitWriteLock())
queuedWriter.IsBackground <- true
queuedWriter.Start()
Thread.Sleep 100
check (queueLock.WaitingWriteCount > 0) "the queued writer must be observable"
let overtook = tryAcquireWriteLockPolling queueLock 200 1
check (not overtook) "polling must not overtake an already queued writer"
queueReader.Join()
queuedWriter.Join()

// A zero budget makes exactly one attempt and never spins.
let zeroBudgetLock = new ReaderWriterLockSlim()
let zeroBudgetReader = startReadHold zeroBudgetLock 200
let zeroBudgetWait = Diagnostics.Stopwatch.StartNew()
let zeroBudgetAcquired = tryAcquireWriteLockPolling zeroBudgetLock 0 1
zeroBudgetWait.Stop()
check (not zeroBudgetAcquired) "a zero budget must not acquire a held lock"
check (zeroBudgetWait.ElapsedMilliseconds < 100L)
      $"a zero budget must return without polling (observed {zeroBudgetWait.ElapsedMilliseconds}ms)"
zeroBudgetReader.Join()
check (zeroBudgetLock.TryEnterWriteLock(100)) "a zero budget attempt must not leak a lock waiter"
zeroBudgetLock.ExitWriteLock()

printfn "LSP lock and request timing regression tests passed"
