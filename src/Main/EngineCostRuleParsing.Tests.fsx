#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/Languages.dll"
#r "../../artifacts/bin/Main/debug/LSP.dll"

#load "../TestHelpers.fsx"

open System
open System.IO
open CWTools.Common
open CWTools.Parser
open CWTools.Process.Scopes
open CWTools.Rules
open CWTools.Utilities
open CWTools.Utilities.StringResource
open Main.Lang.HoverPerformance
open TestHelpers

let harness = TestHarness("EngineCostRuleParsing")

// The scope manager must be initialised before any CWT parse, exactly like the
// real server does when it loads the Stellaris game model.
UtilityParser.initializeScopes None (Some(STLConstants.defaultScopeInputs ()))

let rulesDir =
    [ Path.Combine(__SOURCE_DIRECTORY__, "../../submodules/cwtools-stellaris-config/config")
      Path.Combine(__SOURCE_DIRECTORY__, "../../../submodules/cwtools-stellaris-config/config") ]
    |> List.tryFind Directory.Exists

match rulesDir with
| None -> harness.Fail("rules dir found", "submodules/cwtools-stellaris-config/config not found")
| Some dir ->

    let scopeGroups = scopeManager.ScopeGroups
    let anyScope = scopeManager.AnyScope
    let allScopes = scopeManager.AllScopes

    let parseFile (name: string) =
        let text = File.ReadAllText(Path.Combine(dir, name))
        RulesParser.parseConfig (scopeManager.ParseScope()) allScopes anyScope scopeGroups name text

    // Alias name -> the Options objects declared for it.
    let optionsByName (name: string) =
        let rules, _, _, _, _ = parseFile name

        // The command name lives in the rule's SpecificField, not in the alias
        // group (which is just "trigger"/"effect" for every entry).
        let commandName (rt: RuleType) =
            match rt with
            | LeafRule(SpecificField(SpecificValue key), _) -> Some(stringManager.GetStringForID key.normal)
            | NodeRule(SpecificField(SpecificValue key), _) -> Some(stringManager.GetStringForID key.normal)
            | LeafValueRule(SpecificField(SpecificValue key)) -> Some(stringManager.GetStringForID key.normal)
            | _ -> None

        rules
        |> List.choose (function
            | AliasRule(_, (rt, options)) -> commandName rt |> Option.map (fun n -> n, options)
            | _ -> None)
        |> List.groupBy fst
        |> List.map (fun (a, xs) -> a, xs |> List.map snd)

    let triggers = optionsByName "triggers.cwt"
    let effects = optionsByName "effects.cwt"

    let opts name table = table |> List.tryFind (fun (n, _) -> n = name) |> Option.map snd

    let pick (f: Options -> 'a option) name table =
        opts name table |> Option.bind (List.tryPick f)

    let costOf name table = pick (fun (o: Options) -> o.cost) name table
    let engineOf name table = pick (fun (o: Options) -> o.engine) name table
    let evidenceOf name table = pick (fun (o: Options) -> o.engineEvidence) name table
    let descriptionOf name table = pick (fun (o: Options) -> o.description) name table

    harness.Check "triggers.cwt parses into rules" (triggers.Length > 100)
    harness.Check "effects.cwt parses into rules" (effects.Length > 100)

    // --- cost declarations survive the real parse --------------------------
    harness.Equal "num_ships declares ## cost" (Some "o(n)_owned") (costOf "num_ships" triggers)
    harness.Equal "has_tradition declares ## cost" (Some "o(n)") (costOf "has_tradition" triggers)
    harness.Equal "has_active_tradition declares ## cost" (Some "o(n)") (costOf "has_active_tradition" triggers)
    harness.Equal "has_any_flag declares ## cost" (Some "o(1)") (costOf "has_any_flag" triggers)
    harness.Equal "has_technology declares ## cost" (Some "o(1)") (costOf "has_technology" triggers)
    harness.Equal "num_researched_techs declares ## cost" (Some "script_eval") (costOf "num_researched_techs" triggers)
    harness.Equal "opinion declares ## cost" (Some "script_eval") (costOf "opinion" triggers)
    harness.Equal "habitability declares ## cost" (Some "script_eval") (costOf "habitability" triggers)
    harness.Equal "last_increased_tech declares ## cost" (Some "o(1)") (costOf "last_increased_tech" triggers)
    harness.Equal "is_designable declares ## cost" (Some "semantics") (costOf "is_designable" triggers)
    harness.Equal "set_update_modifiers_batch declares ## cost" (Some "refresh_batch") (costOf "set_update_modifiers_batch" effects)
    harness.Equal "set_country_flag declares ## cost" (Some "o(n)") (costOf "set_country_flag" effects)
    harness.Equal "remove_country_flag declares ## cost" (Some "o(n)") (costOf "remove_country_flag" effects)
    harness.Equal "set_variable declares ## cost" (Some "o(1)") (costOf "set_variable" effects)
    harness.Equal "save_global_event_target_as declares ## cost" (Some "o(log n)") (costOf "save_global_event_target_as" effects)
    harness.Equal "clear_global_event_target declares ## cost" (Some "o(log n)") (costOf "clear_global_event_target" effects)
    let syncOf name table = pick (fun (o: Options) -> o.syncEffect) name table
    harness.Equal "create_country declares ## sync_effect" (Some "heavy") (syncOf "create_country" effects)
    harness.Equal "add_building declares ## sync_effect" (Some "pop_jobs") (syncOf "add_building" effects)

    // --- mechanism and evidence survive too -------------------------------
    harness.Check "num_ships declares ## engine" (engineOf "num_ships" triggers |> Option.isSome)
    harness.Check "num_ships declares ## engine_evidence" (evidenceOf "num_ships" triggers |> Option.isSome)

    harness.Check
        "has_tradition evidence names the engine function"
        (evidenceOf "has_tradition" triggers
         |> Option.exists (fun e -> e.Contains "CCountry::HasTradition"))

    harness.Check
        "has_any_flag evidence names the engine function"
        (evidenceOf "has_any_flag" triggers
         |> Option.exists (fun e -> e.Contains "CHasAnyFlagTrigger"))

    // --- declared cost values are all valid class tokens -------------------
    let allCosts =
        [ yield! triggers |> List.collect (fun (_, os) -> os |> List.choose (fun o -> o.cost))
          yield! effects |> List.collect (fun (_, os) -> os |> List.choose (fun o -> o.cost)) ]

    harness.Check "the bulk engine-cost pass annotated most commands" (allCosts.Length >= 1200)
    harness.Check "both cost classes are well represented" (
        (allCosts |> List.filter (fun c -> c = "o(n)") |> List.length) > 500
        && (allCosts |> List.filter (fun c -> c = "o(1)") |> List.length) > 400)

    let invalid = allCosts |> List.filter (fun c -> tryParseClass c |> Option.isNone)

    harness.Equal "every declared ## cost value is a known class" [] invalid

    // --- fact keys must not leak into hover descriptions -------------------
    harness.Check
        "engine fact keys are excluded from the description"
        (descriptionOf "num_ships" triggers
         |> Option.forall (fun d -> not (d.Contains "cost =") && not (d.Contains "engine =")))

    // --- unannotated commands stay unannotated -----------------------------
    // Commands the extractor could not link to an engine implementation must
    // stay undeclared rather than receive a guessed cost.
    let undeclared =
        [ yield! triggers |> List.filter (fun (_, os) -> os |> List.forall (fun (o: Options) -> o.cost.IsNone)) |> List.map fst
          yield! effects |> List.filter (fun (_, os) -> os |> List.forall (fun (o: Options) -> o.cost.IsNone)) |> List.map fst ]

    harness.Check "some commands remain undeclared" (undeclared.Length > 0)

    // Every declared cost must be one of the classes the hover vocabulary knows.
    harness.Equal "all declared cost values parse" [] (
        allCosts |> List.filter (fun c -> tryParseClass c |> Option.isNone))

harness.Summary() |> ignore
