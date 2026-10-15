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
open TestHelpers

let harness = TestHarness("ModifierDocumentationRuleParsing")

let rulesDir =
    [ Path.Combine(__SOURCE_DIRECTORY__, "../../submodules/cwtools-stellaris-config/config")
      Path.Combine(__SOURCE_DIRECTORY__, "../../../submodules/cwtools-stellaris-config/config") ]
    |> List.tryFind Directory.Exists

// Scope and modifier-category tables must exist before any CWT parse, exactly
// like the real server does when it loads the Stellaris game model.
let load (relative: string) =
    rulesDir
    |> Option.map (fun dir ->
        let path = Path.Combine(dir, relative)
        (path, File.ReadAllText path))

UtilityParser.initializeScopes (load "scopes.cwt") (Some(STLConstants.defaultScopeInputs ()))
UtilityParser.initializeModifierCategories
    (load "modifier_categories.cwt")
    (Some(STLConstants.defaultModifiersInputs ()))

let scopeGroups = scopeManager.ScopeGroups
let anyScope = scopeManager.AnyScope
let allScopes = scopeManager.AllScopes

/// A minimal modifiers mapping: one documented entry, one bare entry.
let expectedProse = "Per-ship-size alias of the ship_target_weight_mult modifier; it enters the target pre-weight wtgt."

let ruleText =
    """
types = {
	type[ship_size] = {
		path = "game/common/ship_sizes"
		modifiers = {
			"shipsize_$_hull_add" = Ships
			### Per-ship-size alias of the ship_target_weight_mult modifier; it enters the target pre-weight wtgt.
			"shipsize_$_target_weight_mult" = Ships
		}
	}
}
"""

let parseTypes (name: string) (text: string) =
    let _, types, _, _, _ =
        RulesParser.parseConfig (scopeManager.ParseScope()) allScopes anyScope scopeGroups name text

    types

/// Modifier key -> Options.description, i.e. what hover and completion read.
let descriptionsOf (types: TypeDefinition list) =
    RulesHelpers.generateModifierRulesFromTypes types
    |> List.choose (fun rule ->
        match rule with
        | AliasRule("modifier", (LeafRule(TypeField field, _), options)) ->
            let name =
                match field with
                | TypeType.Simple simple -> simple
                | TypeType.Complex(prefix, inner, suffix) -> prefix + inner + suffix

            Some(name, options.description)
        | _ -> None)

let described = descriptionsOf (parseTypes "probe.cwt" ruleText)

/// The generated key is prefix + type name + suffix, so match on the suffix.
let lookup (table: (string * string option) list) suffix =
    table
    |> List.tryPick (fun (key, value) -> if key.EndsWith(suffix, StringComparison.Ordinal) then Some value else None)

harness.Equal "both typed modifiers become rules" 2 described.Length

// --- the documented modifier carries its prose ------------------------------

match lookup described "target_weight_mult" with
| Some description ->
    harness.Check
        "the comment reaches Options.description"
        (description |> Option.exists (fun text -> text.Trim() = expectedProse))
| None -> harness.Fail "the comment reaches Options.description (no rule for the documented modifier)"

// --- an undocumented modifier stays clean -----------------------------------

harness.Check "an undocumented modifier produces no description" (lookup described "hull_add" = Some None)

// --- the shipped Stellaris rules -------------------------------------------

match rulesDir with
| None -> harness.Fail "rules dir found (submodules/cwtools-stellaris-config/config not found)"
| Some dir ->
    let shipSizesPath = Path.Combine(dir, "common/ship_sizes.cwt")
    let shipSizesText = File.ReadAllText(shipSizesPath)
    let shipSizeDescriptions = descriptionsOf (parseTypes shipSizesPath shipSizesText)

    harness.Check "ship_sizes.cwt produces modifier rules" (shipSizeDescriptions.Length > 50)

    match lookup shipSizeDescriptions "target_weight_mult" with
    | Some description ->
        harness.Check
            "the shipped target_weight_mult alias documents itself"
            (description |> Option.exists (fun text -> text.Contains "Targeting:" && text.Contains "wtgt"))
    | None ->
        harness.Fail "the shipped target_weight_mult alias documents itself (no rule produced)"

    // The documented entry must not leak its prose onto its neighbours.
    harness.Check "undocumented neighbours stay undocumented" (lookup shipSizeDescriptions "hull_add" = Some None)

    let documented =
        shipSizeDescriptions
        |> List.choose (fun (_, value) -> value)
        |> List.filter (fun text -> not (String.IsNullOrWhiteSpace text))

    harness.Check "at least one shipped modifier documents itself" (not documented.IsEmpty)
    harness.Check
        "no shipped modifier description is empty prose"
        (documented |> List.forall (fun text -> text.Trim().Length > 0))

harness.Summary() |> ignore
