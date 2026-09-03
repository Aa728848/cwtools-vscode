#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"

#load "../TestHelpers.fsx"
#load "PdxFragmentValidation.fs"

open CWTools.Parser
open FParsec
open Main.PdxFragmentValidation
open TestHelpers

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

printfn "PdxFragmentValidation regression tests passed"
