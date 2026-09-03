#load "../TestHelpers.fsx"
#load "Locking.fs"

open System
open System.Threading
open LSP.Locking
open TestHelpers


let assertDecision cause expectedOutcome expectedResponse =
    let actual = decideRequestTerminal cause
    assertEqual expectedOutcome actual.outcome $"{expectedOutcome} outcome"
    assertEqual expectedResponse actual.response $"{expectedOutcome} response"

assertDecision (RequestTerminalCause.Success "{\"ok\":true}") "success" (RequestTerminalResponse.Result "{\"ok\":true}")
assertDecision RequestTerminalCause.Cancelled "cancelled" (RequestTerminalResponse.Error(-32800, "Request cancelled"))
assertDecision RequestTerminalCause.Timeout "timeout" (RequestTerminalResponse.Error(-32000, "Request timed out"))
assertDecision RequestTerminalCause.Exception "error" (RequestTerminalResponse.Error(-32603, "Internal error"))

let runWrite token workflow =
    let mutable entered = 0
    let mutable exited = 0
    let cause =
        runWriteRequestTerminal
            (fun () -> entered <- entered + 1)
            (fun () -> exited <- exited + 1)
            token
            workflow
    cause, entered, exited

let success, successEntered, successExited = runWrite CancellationToken.None (async { return Some "42" })
assertEqual (RequestTerminalCause.Success "42") success "write success cause"
assertEqual 1 successEntered "write success lock acquire"
assertEqual 1 successExited "write success lock release"

let nullResult, _, nullExited = runWrite CancellationToken.None (async { return None })
assertEqual (RequestTerminalCause.Success "null") nullResult "write null cause"
assertEqual 1 nullExited "write null lock release"

let timeout, _, timeoutExited =
    runWrite CancellationToken.None (async { return raise (TimeoutException("server timeout")) })
assertEqual RequestTerminalCause.Timeout timeout "write timeout cause"
assertEqual 1 timeoutExited "write timeout lock release"

let failure, _, failureExited =
    runWrite CancellationToken.None (async { return raise (InvalidOperationException("boom")) })
assertEqual RequestTerminalCause.Exception failure "write exception cause"
assertEqual 1 failureExited "write exception lock release"

let cancelledBeforeStart = new CancellationTokenSource()
try
    cancelledBeforeStart.Cancel()
    let preCancelled, preEntered, preExited =
        runWrite cancelledBeforeStart.Token (async { return Some "must not run" })
    assertEqual RequestTerminalCause.Cancelled preCancelled "write pre-cancel cause"
    assertEqual 0 preEntered "write pre-cancel lock acquire"
    assertEqual 0 preExited "write pre-cancel lock release"
finally
    cancelledBeforeStart.Dispose()

let yieldedCancellation = new CancellationTokenSource()
try
    let yielded, _, yieldedExited =
        runWrite
            yieldedCancellation.Token
            (async {
                do! Async.SwitchToThreadPool()
                yieldedCancellation.Cancel()
                do! Async.Sleep 1
                return Some "must not complete"
            })
    assertEqual RequestTerminalCause.Cancelled yielded "write async-yield cancellation cause"
    assertEqual 1 yieldedExited "write async-yield cancellation lock release"
finally
    yieldedCancellation.Dispose()

let mutable claimAvailable = true
let emitted = ResizeArray<RequestTerminalDecision>()
let claim () =
    if claimAvailable then
        claimAvailable <- false
        Some ()
    else None
let emit () decision = emitted.Add decision

assertEqual true (tryTerminalizeRequest claim emit RequestTerminalCause.Cancelled) "first cancellation claims terminal gate"
assertEqual false (tryTerminalizeRequest claim emit RequestTerminalCause.Cancelled) "second cancellation loses terminal gate"
assertEqual 1 emitted.Count "cancellation emitted exactly once"
assertEqual (RequestTerminalResponse.Error(-32800, "Request cancelled")) emitted.[0].response "single cancellation response"

printfn "LSP executable terminal regression tests passed"
