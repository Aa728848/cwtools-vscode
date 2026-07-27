#load "Locking.fs"

open System.Threading
open LSP.Locking

let stateLock = new ReaderWriterLockSlim()

let result =
    runReadLocked
        stateLock
        (Some 100)
        CancellationToken.None
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
printfn "LSP lock regression tests passed"
