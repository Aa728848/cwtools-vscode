// Phase 4 candidate-activation tests (CwtActivation + CwtProjectIndex).
//
// Covers the decideActivation state machine: activation on valid candidates,
// last-known-good on rejection, upgrade after repair, and content-hash
// determinism. Run from this directory (after `dotnet build src/Main/`):
//
//     dotnet fsi CwtActivation.Tests.fsx

#r "../../submodules/cwtools/artifacts/bin/CWTools/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/LSP/debug/LSP.dll"
#r "../../artifacts/bin/Main/debug/CWTools Server.dll"

open System
open System.Diagnostics
open System.IO
open System.Threading
open CWTools.CwtLanguage
open LSP
open Main.Lang

let mutable failures = 0

let check (name: string) (condition: bool) =
    if condition then printfn "PASS %s" name
    else
        failures <- failures + 1
        printfn "FAIL %s" name

let tmpRoot =
    let dir = Path.Combine(Path.GetTempPath(), "cwt-activation-tests-" + Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory(dir) |> ignore
    dir

let build (version: int64) (files: (string * string) list) =
    CwtProjectIndex.buildSnapshot version 100 1_000_000L tmpRoot files

// --- workspace/root policy ---------------------------------------------------

check "CWT-only mode indexes the workspace"
    (CwtLanguageFeatures.selectRuleRoot true false None tmpRoot = Some tmpRoot)

check "automatic game rules do not treat the workspace as a rule root"
    (CwtLanguageFeatures.selectRuleRoot false false None tmpRoot = None)

check "manual game rules index only the configured rules folder"
    (CwtLanguageFeatures.selectRuleRoot false true (Some tmpRoot) "ignored" = Some tmpRoot)

check "only a matching manual folder can activate game rules"
    (CwtLanguageFeatures.isManualActivationRoot false true (Some tmpRoot) tmpRoot
     && not (CwtLanguageFeatures.isManualActivationRoot true true (Some tmpRoot) tmpRoot)
     && not (CwtLanguageFeatures.isManualActivationRoot false false (Some tmpRoot) tmpRoot)
     && not (CwtLanguageFeatures.isManualActivationRoot false true (Some tmpRoot) (Path.Combine(tmpRoot, "other"))))

let enumerationRoot = Path.Combine(tmpRoot, "enumeration")
let outsideRoot = Path.Combine(Path.GetTempPath(), "cwt-enumeration-outside-" + Guid.NewGuid().ToString("N"))
Directory.CreateDirectory(enumerationRoot) |> ignore
Directory.CreateDirectory(outsideRoot) |> ignore
let insideRule = Path.Combine(enumerationRoot, "inside.cwt")
let outsideRule = Path.Combine(outsideRoot, "outside.cwt")
File.WriteAllText(insideRule, "types = { }\n")
File.WriteAllText(outsideRule, "types = { }\n")

let docs = DocumentStore()
let directEnumeration = CwtLanguageFeatures.enumerateCwtFiles enumerationRoot docs 100 |> List.map fst
check "enumeration includes files below the real root" (directEnumeration = [ Path.GetFullPath(insideRule) ])
check "enumeration rejects an invalid configured root without throwing"
    (CwtLanguageFeatures.enumerateCwtFiles "\u0000" docs 100 |> List.isEmpty)

let outsideLink = Path.Combine(enumerationRoot, "outside-link")
let loopLink = Path.Combine(enumerationRoot, "loop")
let linksCreated =
    try
        Directory.CreateSymbolicLink(outsideLink, outsideRoot) |> ignore
        Directory.CreateSymbolicLink(loopLink, enumerationRoot) |> ignore
        true
    with _ -> false

if linksCreated then
    let linkedEnumeration = CwtLanguageFeatures.enumerateCwtFiles enumerationRoot docs 100 |> List.map fst
    check "enumeration rejects directory links outside the rule root"
        (linkedEnumeration = [ Path.GetFullPath(insideRule) ])
else
    printfn "SKIP enumeration symlink checks (symbolic links unavailable)"

let waitUntil timeoutMs predicate =
    let timer = Stopwatch.StartNew()
    while timer.ElapsedMilliseconds < int64 timeoutMs && not (predicate ()) do
        Thread.Sleep(10)
    predicate ()

let rebuildRoot = Path.Combine(tmpRoot, "rebuild")
Directory.CreateDirectory(rebuildRoot) |> ignore
let rebuildRule = Path.Combine(rebuildRoot, "rules.cwt")
File.WriteAllText(rebuildRule, "types = { }\n")
let activationVersions = ResizeArray<int64>()
let activationLock = obj()
CwtLanguageFeatures.canActivateRulesFromRoot <- Some(fun root -> root = rebuildRoot)
CwtLanguageFeatures.onActivationReady <- Some(fun request -> lock activationLock (fun () -> activationVersions.Add(request.snapshot.version)))
CwtLanguageFeatures.requestSnapshotRebuild rebuildRoot docs 250
File.WriteAllText(rebuildRule, "types = { type[newer] = { path = \"x\" } }\n")
CwtLanguageFeatures.requestSnapshotRebuild rebuildRoot docs 10

check "a newer rebuild cancels the pending activation request"
    (waitUntil 2000 (fun () -> lock activationLock (fun () -> activationVersions.Count = 1))
     && (Thread.Sleep(350); lock activationLock (fun () -> activationVersions.Count = 1)))

let rejectionRoot = Path.Combine(tmpRoot, "rejection")
Directory.CreateDirectory(rejectionRoot) |> ignore
let rejectionRule = Path.Combine(rejectionRoot, "bad-cardinality.cwt")
File.WriteAllText(rejectionRule, "## cardinality = banana\ntypes = { }\n")
CwtLanguageFeatures.canActivateRulesFromRoot <- Some(fun root -> root = rejectionRoot)
CwtLanguageFeatures.onActivationReady <- Some(ignore)
CwtLanguageFeatures.requestSnapshotRebuild rejectionRoot docs 0

check "rejected candidates publish CWT900 on the current snapshot"
    (waitUntil 2000 (fun () ->
        CwtLanguageFeatures.projectErrorsForFile rejectionRule
        |> List.exists (fun (code, _, _, _, _, _, _) -> code = "CWT900")))

CwtLanguageFeatures.canActivateRulesFromRoot <- None
CwtLanguageFeatures.onActivationReady <- None

// --- content hash ------------------------------------------------------------

let validFiles =
    [ Path.Combine(tmpRoot, "rules.cwt"), "types = {\n\ttype[gadget] = {\n\t\tpath = \"x\"\n\t}\n}\n"
      Path.Combine(tmpRoot, "enums.cwt"), "enums = {\n\tenum[widget] = {\n\t\tA\n\t}\n}\n" ]

let validFilesReversed = List.rev validFiles

check "contentHash: order independent"
    (CwtActivation.contentHash validFiles = CwtActivation.contentHash validFilesReversed)

check "contentHash: content sensitive"
    (CwtActivation.contentHash validFiles
     <> CwtActivation.contentHash [ Path.Combine(tmpRoot, "rules.cwt"), "types = { }\n"
                                    Path.Combine(tmpRoot, "enums.cwt"), "enums = {\n\tenum[widget] = {\n\t\tA\n\t}\n}\n" ])

// --- decideActivation: happy path -------------------------------------------

let snapshot1 = build 1L validFiles

check "no active rules + valid candidate -> Activate"
    (match CwtActivation.decideActivation snapshot1 validFiles None with
     | CwtActivation.Activate -> true
     | _ -> false)

check "same content hash -> NoChange"
    (match CwtActivation.decideActivation
              snapshot1
              validFiles
              (Some { CwtActivation.CwtActiveRules.generation = 1; contentHash = CwtActivation.contentHash validFiles }) with
     | CwtActivation.NoChange -> true
     | _ -> false)

// --- last-known-good: parse failure -------------------------------------------

let brokenFiles =
    [ Path.Combine(tmpRoot, "broken.cwt"), "types = {\n\ttype[x] = {\n"   // missing brace

      Path.Combine(tmpRoot, "ok.cwt"), "types = { }\n" ]

let brokenSnapshot = build 2L brokenFiles

check "parse failure blocks activation"
    (match CwtActivation.decideActivation brokenSnapshot brokenFiles None with
     | CwtActivation.Rejected reason -> reason.Contains "broken.cwt"
     | _ -> false)

// --- last-known-good: blocking diagnostic --------------------------------------

let blockingFiles =
    [ Path.Combine(tmpRoot, "bad.cwt"), "count = int[0..banana]\n" ]   // CWT201

let blockingSnapshot = build 3L blockingFiles

check "blocking diagnostic (CWT201) blocks activation"
    (match CwtActivation.decideActivation blockingSnapshot blockingFiles None with
     | CwtActivation.Rejected reason -> reason.Contains "CWT201"
     | _ -> false)

let invalidCardinalityFiles =
    [ Path.Combine(tmpRoot, "bad-cardinality.cwt"), "## cardinality = banana\ntypes = { }\n" ]

let invalidCardinalitySnapshot = build 31L invalidCardinalityFiles

check "every Error diagnostic blocks activation (CWT102)"
    (match CwtActivation.decideActivation invalidCardinalitySnapshot invalidCardinalityFiles None with
     | CwtActivation.Rejected reason -> reason.Contains "CWT102"
     | _ -> false)

// --- warnings do not block ------------------------------------------------------

let warningFiles =
    [ Path.Combine(tmpRoot, "uses.cwt"),
      "types = {\n\ttype[a] = {\n\t\tpath = \"x\"\n\t}\n}\nicon = <missing_type>\n" ]   // CWT301 warning

let warningSnapshot = build 4L warningFiles

check "warning-only candidate activates"
    (match CwtActivation.decideActivation warningSnapshot warningFiles None with
     | CwtActivation.Activate -> true
     | _ -> false)

// --- upgrade after repair --------------------------------------------------------

// Failed candidate keeps the active identity; a repaired candidate upgrades.
let activeHash = CwtActivation.contentHash validFiles

check "rejected candidate leaves active rules untouched"
    (match CwtActivation.decideActivation blockingSnapshot blockingFiles
              (Some { CwtActivation.CwtActiveRules.generation = 5; contentHash = activeHash }) with
     | CwtActivation.Rejected _ -> true
     | _ -> false)

let repairedFiles =
    [ Path.Combine(tmpRoot, "fixed.cwt"), "count = int[0..10]\n" ]   // now valid

let repairedSnapshot = build 6L repairedFiles

check "repaired candidate upgrades from last-known-good"
    (match CwtActivation.decideActivation repairedSnapshot repairedFiles
              (Some { CwtActivation.CwtActiveRules.generation = 5; contentHash = activeHash }) with
     | CwtActivation.Activate -> true
     | _ -> false)

// --- candidateIsUsable ------------------------------------------------------------

check "candidateIsUsable true for clean snapshot"
    (CwtActivation.candidateIsUsable snapshot1 CwtActivation.defaultBlockingCodes)

check "candidateIsUsable false with parse failure"
    (not (CwtActivation.candidateIsUsable brokenSnapshot CwtActivation.defaultBlockingCodes))

// --- summary ----------------------------------------------------------------------

try Directory.Delete(tmpRoot, true) with _ -> ()
try Directory.Delete(outsideRoot, true) with _ -> ()

printfn ""

if failures = 0 then
    printfn "CwtActivation.Tests.fsx: all checks passed."
    0
else
    printfn "CwtActivation.Tests.fsx: %d check(s) FAILED." failures
    1
