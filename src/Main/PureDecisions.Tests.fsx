#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"

#load "../TestHelpers.fsx"
#load "PureDecisions.fs"

open CWTools.Parser
open FParsec
open Main.CompletionFallbackPolicy
open Main.PdxFragmentValidation
open TestHelpers

let assertEqual = assertEqualNamed

// 1. CompletionFallbackPolicy Tests
assertEqual
    "validation alone does not trigger immediate fallback"
    false
    (shouldUseImmediateFallback false false)

assertEqual
    "validation alone cannot produce an empty fallback"
    false
    (canReturnEmptyFallback false)

assertEqual
    "an active writer still triggers the bounded fallback"
    true
    (shouldUseImmediateFallback true false)

assertEqual
    "an active writer may return an empty fallback"
    true
    (canReturnEmptyFallback true)

assertEqual
    "the heavy interactive window still prefers a cached fallback"
    true
    (shouldUseImmediateFallback false true)

// 2. PdxFragmentValidation Tests
let multiRoot = "first = { key = yes }\n\nsecond = { key = no }\n"
let parseSucceeded =
    match CKParser.parseString multiRoot "fragment://virtual.txt" with
    | Success _ -> true
    | Failure(message, _, _) -> failwith $"multi-root fragment should parse: {message}"

let mutable recoveryCalled = false
let recoveryDiagnostics =
    collectWhenParseFails parseSucceeded [] (fun () ->
        recoveryCalled <- true
        [ "CW001_STRUCTURAL_RECOVERY" ])

check (not recoveryCalled) "recovery diagnostics ran after a successful complete parse"
check (recoveryDiagnostics.IsEmpty) (sprintf "successful multi-root parse produced recovery diagnostics: %A" recoveryDiagnostics)

let fallbackDiagnostics = collectWhenParseFails false [] (fun () -> [ "parser error" ])
equal [ "parser error" ] fallbackDiagnostics "failed parses must still collect fallback diagnostics"

printfn "PureDecisions regression tests passed (CompletionFallbackPolicy + PdxFragmentValidation)"
