// Phase 0 performance baseline probe for the CWT parsing stack.
//
// Measures single-file CKParser + parseConfigWithMetadata latency across the
// golden corpus, representative real files, and the full Stellaris rule
// repository. Results are recorded (not asserted) in
// docs/cwt-language-support-baseline.md; no thresholds are invented here.
//
// Run from this directory (after `dotnet build src/Main/`):
//
//     dotnet fsi CwtLanguageBaseline.fsx
//
// Output is a stable, sortable table so a later run can be diffed.

#r "../../submodules/cwtools/artifacts/bin/CWTools/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/Main/debug/CWTools Server.dll"

open System
open System.IO
open System.Diagnostics
open FParsec
open CWTools.Common
open CWTools.Parser
open CWTools.Rules

let repoRoot = Path.GetFullPath(Path.Combine(__SOURCE_DIRECTORY__, "..", ".."))

// --- Scope bootstrap (mirrors CwtLanguageService.Tests.fsx) ----------------
let scopeInputs =
    [| { ScopeInput.name = "Country"; aliases = [ "country" ]; isSubscopeOf = []; dataTypeName = None }
       { ScopeInput.name = "Planet"; aliases = [ "planet" ]; isSubscopeOf = []; dataTypeName = None }
       { ScopeInput.name = "Leader"; aliases = [ "leader" ]; isSubscopeOf = []; dataTypeName = None } |]

scopeManager.ReInit(scopeInputs, [||])
let parseScope = scopeManager.ParseScope()
let anyScope = scopeManager.AnyScope
let allScopes = scopeManager.AllScopes
let scopeGroups = scopeManager.ScopeGroups

let measureSingle (label: string) (file: string) =
    let text = File.ReadAllText file
    let name = Path.GetFileName file
    let sw = Stopwatch.StartNew()
    let parsed = CKParser.parseString text name
    let parseMs = sw.Elapsed.TotalMilliseconds

    sw.Restart()
    let rules, types, enums, _, _, _ = RulesParser.parseConfigWithMetadata parseScope allScopes anyScope scopeGroups name text
    let modelMs = sw.Elapsed.TotalMilliseconds
    let status =
        match parsed with
        | Success(_, _, _) -> "ok"
        | Failure(_, _, _) -> "failure"
    printfn "single\t%s\t%d\t%.2f\t%.2f\t%s\trules=%d types=%d enums=%d" label text.Length parseMs modelMs status rules.Length types.Length enums.Length

let corpusRoot = Path.Combine(repoRoot, "client", "test", "fixtures", "cwt")
let configRoot = Path.Combine(repoRoot, "submodules", "cwtools-stellaris-config", "config")

// Representative real files (small / medium / large).
let realFiles =
    [ "config/scopes.cwt", Path.Combine(configRoot, "scopes.cwt")
      "config/enums.cwt", Path.Combine(configRoot, "enums.cwt")
      "config/common/buildings.cwt", Path.Combine(configRoot, "common", "buildings.cwt")
      "config/triggers.cwt", Path.Combine(configRoot, "triggers.cwt")
      "config/effects.cwt", Path.Combine(configRoot, "effects.cwt") ]

printfn "=== single-file probe ==="
printfn "label\tbytes\tparseMs\tmodelMs\tstatus\tsummary"

for subdir in [ "valid"; "invalid"; "semantic" ] do
    Directory.GetFiles(Path.Combine(corpusRoot, subdir), "*.cwt")
    |> Array.sortBy Path.GetFileName
    |> Array.iter (fun f ->
        measureSingle $"corpus/%s{subdir}/%s{Path.GetFileName f}" f)

for label, file in realFiles do
    measureSingle label file

// --- Full rule repository probe -------------------------------------------
printfn "=== repository probe ==="

let allRuleFiles =
    Directory.GetFiles(configRoot, "*.cwt", SearchOption.AllDirectories)
    |> Array.sort

let sw = Stopwatch.StartNew()
let mutable totalBytes = 0L

let repoResults =
    allRuleFiles
    |> Array.map (fun f ->
        let text = File.ReadAllText f
        totalBytes <- totalBytes + int64 text.Length
        let name = Path.GetFileName f
        let parsed = CKParser.parseString text name
        (name, text, parsed))

let readMs = sw.Elapsed.TotalMilliseconds

sw.Restart()
let _, _, _, _, _, _ =
    RulesParser.parseConfigs
        parseScope allScopes anyScope scopeGroups true false
        (repoResults |> Array.map (fun (name, text, _) -> name, text) |> Array.toList)

let modelMs = sw.Elapsed.TotalMilliseconds
let failures =
    repoResults |> Array.choose (fun (name, _, parsed) ->
        match parsed with Failure(_, _, _) -> Some name | _ -> None)

printfn "repo\tfiles=%d\tbytes=%d\treadAndParseMs=%.2f\tmodelMs=%.2f\tparseFailures=%d" allRuleFiles.Length totalBytes readMs modelMs failures.Length

if failures.Length > 0 then
    printfn "repo failures: %s" (String.Join(", ", failures))

printfn "=== done ==="
