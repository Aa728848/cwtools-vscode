#load "SemanticDelta.fs"

open Main.SemanticDelta

let private assertEqual name expected actual =
    if expected <> actual then
        failwith $"{name}: expected {expected}, got {actual}"

let unknownSemanticDelta =
    { semanticDeltaForPath "common/colony_automation_exceptions/test.txt" with
        domains = Set.ofList [ "types"; "rules" ]
        completionVisible = true
        validationVisible = true }

assertEqual
    "generic unknown semantic changes remain conservative"
    (FullRefresh "unsafe_change_or_patch_budget_exceeded")
    (decideSemanticDelta unknownSemanticDelta 0 25)

assertEqual
    "committed type-index saves never promote to a full refresh"
    TypeIndexOnly
    (decideCommittedSemanticDelta
        CommittedTypeIndex
        true
        unknownSemanticDelta
        25
        25)

assertEqual
    "committed scripted-service saves ignore the historical patch budget"
    ScriptedServices
    (decideCommittedSemanticDelta
        CommittedScriptedServices
        true
        unknownSemanticDelta
        25
        25)

printfn "SemanticDelta regression tests passed"
