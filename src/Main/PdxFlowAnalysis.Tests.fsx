#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.DesignTime.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.dll"

open System
open FSharp.Data
open CWTools.Process
open CWTools.Games
open Main.PdxFlowAnalysis

let private assertTrue name condition =
    if not condition then failwith $"{name}: expected true"

let parseEntity (content: string) (filePath: string) : Entity =
    let parsed = CWTools.Parser.CKParser.parseString content filePath
    match parsed with
    | FParsec.CharParsers.Success(files, _, _) ->
        let root = STLProcess.simpleProcess.ProcessNode () "root" (CWTools.Utilities.Utils.mkZeroFile filePath) files
        { filepath = filePath
          logicalpath = filePath
          rawEntity = root
          entity = root
          validate = true
          entityType = CWTools.Common.STLConstants.EntityType.Events
          overwrite = CWTools.Games.Overwrite.No }
    | _ -> failwith $"failed to parse {filePath}"

// ─── static cost model: pulse + nested every must surface as high cost ─────
let costContent = """on_actions = {
    on_monthly = {
        every_country = {
            limit = { has_country_flag = test }
            while = {
                limit = { value > 0 }
                change_variable = { which = value value = -1 }
                every_owned_planet = {
                    add_planet_modifier = { modifier = test }
                }
            }
            while = {
                every_system = { set_system_flag = needs_review }
            }
        }
    }
}
"""
let costEntity = parseEntity costContent "common/on_actions/test_on_actions.txt"

let costFacts = collectCosts costEntity.rawEntity "common/on_actions/test_on_actions.txt"
assertTrue "pulse handler is detected"
    (costFacts |> List.exists (fun item -> item.kind = "pulse_handler" && item.name.Contains "on_monthly"))
let nestedEvery = costFacts |> List.filter (fun item -> item.name = "every_owned_planet")
assertTrue "nested every traversal is detected with depth"
    (nestedEvery |> List.exists (fun item -> item.nestingDepth >= 2 && item.amplification.StartsWith "nested_depth"))
assertTrue "bounded and progressing while is not called definitely unbounded"
    (costFacts |> List.exists (fun item -> item.name = "while" && item.amplification = "bounded_or_progressing_loop"))
assertTrue "while without visible progress remains a review warning"
    (costFacts |> List.exists (fun item -> item.name = "while" && item.amplification = "potential_unbounded_loop"))
let everyCountry = costFacts |> List.filter (fun item -> item.name = "every_country")
assertTrue "country traversal reports country_wide amplification"
    (everyCountry |> List.exists (fun item -> item.traversalRange = "country" && not (String.IsNullOrWhiteSpace item.frequency)))

// ─── gameplay relations: technology prerequisites and special project events ─
let techContent = """technology = {
    key = "tech_kuat_warp"
    prerequisites = { "tech_kuat_drive" "tech_kuat_core" }
}
"""
let techEntity = parseEntity techContent "common/technology/kuat_tech.txt"

let relations = collectRelations techEntity.rawEntity "common/technology/kuat_tech.txt" "tech_kuat_warp" "technology"
assertTrue "technology prerequisites become directed edges"
    (relations |> List.exists (fun item ->
        item.relationType = "prerequisite_of" && item.targetId = "tech_kuat_drive"))
assertTrue "second prerequisite is captured"
    (relations |> List.exists (fun item -> item.targetId = "tech_kuat_core"))

let projectContent = """special_project = {
    key = "kuat_project"
    on_success = { country_event = { id = kuat_success.1 } }
    on_fail = { country_event = { id = kuat_fail.1 } }
}
"""
let projectEntity = parseEntity projectContent "common/special_projects/kuat_project.txt"
let projectRelations = collectRelations projectEntity.rawEntity "common/special_projects/kuat_project.txt" "kuat_project" "special_project"
assertTrue "special project success event edge"
    (projectRelations |> List.exists (fun item -> item.relationType = "special_project_success_event" && item.targetId = "kuat_success.1"))

let stateContent = """country_event = {
    id = state.1
    trigger = { has_country_flag = branch_flag }
    trigger = { event_target:missing_target = { exists = yes } }
    if = { limit = { always = yes } set_country_flag = branch_flag }
    save_event_target_as = delayed_target
    country_event = { id = state.2 days = 10 }
    last_created_fleet = { set_fleet_flag = created }
}
"""
let stateEntity = parseEntity stateContent "events/state.txt"
let issues = stateIssues "state.1" "events/state.txt" stateEntity.rawEntity
assertTrue "state read before unconditional initialization is reported"
    (issues |> List.exists (fun item -> item.kind = "use_before_initialization" || item.kind = "branch_incomplete_initialization"))
assertTrue "direct event_target reads preserve the target name"
    (issues |> List.exists (fun item -> item.subject = "missing_target" && item.kind = "use_before_initialization"))
assertTrue "delayed local event target risk is reported"
    (issues |> List.exists (fun item -> item.kind = "delayed_local_event_target_risk"))
assertTrue "last_created implicit state dependency is reported"
    (issues |> List.exists (fun item -> item.kind = "implicit_created_scope_dependency"))

// ─── JSON contract ──────────────────────────────────────────────────────────
let facts =
    { costs = costFacts
      relations = relations @ projectRelations
      issues = issues
      filesConsidered = 3
      definitionsConsidered = 2
      truncated = false }
let json = flowAnalysisJson facts
assertTrue "json ok flag"
    (json.Item("ok").AsBoolean())
assertTrue "json advertises the interprocedural flow contract"
    (json.Item("version").AsInteger() = 3)
assertTrue "json cost caveat present"
    (json.Item("costModel").Item("caveat").AsString().Contains "Relative static weights")
assertTrue "json exposes costs and relations"
    (json.Item("costs").AsArray().Length >= 3
     && json.Item("relations").AsArray().Length >= 3)
assertTrue "json exposes structured state issues"
    (json.Item("issues").AsArray().Length >= 2)

printfn "PdxFlowAnalysis regression tests passed"
