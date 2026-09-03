// Shared test helpers for .fsx regression tests across src/Main and src/LSP.
// Load via: #load "../TestHelpers.fsx"

module TestHelpers

open System
open System.IO

// ----------------------------------------------------------------------------
// Fail-fast assertions (failwith on mismatch)
// ----------------------------------------------------------------------------

let check (condition: bool) (message: string) =
    if not condition then failwith message

let checkNamed (name: string) (condition: bool) =
    if not condition then failwithf "FAILED: %s" name

let assertTrue (condition: bool) (message: string) =
    check condition message

let equal (expected: 'T) (actual: 'T) (message: string) =
    if expected <> actual then
        failwithf "%s. Expected %A, got %A" message expected actual

let assertEqual (expected: 'T) (actual: 'T) (message: string) =
    equal expected actual message

let assertEqualNamed (name: string) (expected: 'T) (actual: 'T) =
    if expected <> actual then
        failwith $"{name}: expected {expected}, got {actual}"

let assertNotEqualNamed (name: string) (left: 'T) (right: 'T) =
    if left = right then
        failwith $"{name}: expected distinct values, got {left}"

let throws<'T when 'T :> exn> (action: unit -> unit) (message: string) =
    try
        action ()
        failwith (message + ": expected exception of type " + typeof<'T>.Name + " but none was thrown")
    with
    | :? 'T -> ()

let capture<'T when 'T :> exn> (action: unit -> unit) (message: string) : 'T =
    try
        action ()
        failwith (message + ": expected exception of type " + typeof<'T>.Name + " but none was thrown")
    with
    | :? 'T as error -> error

// ----------------------------------------------------------------------------
// Reporting test harness (tracks pass/fail counts, non-throwing, returns exit code)
// ----------------------------------------------------------------------------

type TestHarness(suiteName: string) =
    let mutable passes = 0
    let mutable failures = 0

    member _.Pass(name: string) =
        passes <- passes + 1
        printfn "PASS %s" name

    member _.Fail(name: string, ?detail: string) =
        failures <- failures + 1
        match detail with
        | Some d -> printfn "FAIL %s: %s" name d
        | None -> printfn "FAIL %s" name

    member this.Check (name: string) (condition: bool) =
        if condition then this.Pass(name)
        else this.Fail(name)

    member this.Equal (name: string) (expected: 'T) (actual: 'T) =
        if expected = actual then this.Pass(name)
        else this.Fail(name, sprintf "expected %A, got %A" expected actual)

    member _.Failures = failures
    member _.Passes = passes

    member _.Summary() : int =
        printfn ""
        if failures = 0 then
            printfn "%s: all %d checks passed." suiteName passes
            0
        else
            printfn "%s: %d check(s) FAILED (out of %d total)." suiteName failures (passes + failures)
            1

// ----------------------------------------------------------------------------
// Temp directory helpers
// ----------------------------------------------------------------------------

let createTempDir (prefix: string) : string =
    let dir = Path.Combine(Path.GetTempPath(), prefix + "-" + Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory(dir) |> ignore
    dir

let cleanupTempDir (dir: string) =
    try
        if Directory.Exists(dir) then
            Directory.Delete(dir, true)
    with _ -> ()

let withTempDir (prefix: string) (action: string -> 'a) : 'a =
    let dir = createTempDir prefix
    try
        action dir
    finally
        cleanupTempDir dir
