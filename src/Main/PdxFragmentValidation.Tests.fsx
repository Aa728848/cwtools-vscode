#r "../../submodules/cwtools/artifacts/bin/CWTools/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"

#load "PdxFragmentValidation.fs"

open CWTools.Parser
open FParsec
open Main.PdxFragmentValidation

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

if recoveryCalled then
    failwith "recovery diagnostics ran after a successful complete parse"
if not recoveryDiagnostics.IsEmpty then
    failwithf "successful multi-root parse produced recovery diagnostics: %A" recoveryDiagnostics

let fallbackDiagnostics = collectWhenParseFails false [] (fun () -> [ "parser error" ])
if fallbackDiagnostics <> [ "parser error" ] then
    failwith "failed parses must still collect fallback diagnostics"

printfn "PdxFragmentValidation regression tests passed"
