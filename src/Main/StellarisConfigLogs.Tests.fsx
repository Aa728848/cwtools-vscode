#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/Languages.dll"
#r "../../artifacts/bin/Main/debug/LSP.dll"

#load "../TestHelpers.fsx"

open System.IO
open CWTools.Common
open CWTools.Parser
open CWTools.Utilities
open CWTools.Process.Scopes
open TestHelpers

// Regression for the bundled engine documentation logs. The language server
// reads config/logs/*.log instead of the game's script_documentation folder,
// so a stale copy silently weakens modifier and trigger validation.
let harness = TestHarness("StellarisConfigLogs")

let rulesDir =
    [ Path.Combine(__SOURCE_DIRECTORY__, "../../submodules/cwtools-stellaris-config/config")
      Path.Combine(__SOURCE_DIRECTORY__, "../../../submodules/cwtools-stellaris-config/config") ]
    |> List.tryFind Directory.Exists

match rulesDir with
| None -> harness.Fail("rules dir found", "submodules/cwtools-stellaris-config/config not found")
| Some dir ->

    // Modifier categories must be initialized before parsing modifiers.log.
    // Without this every entry emits a logError, which fills the stderr pipe of
    // the test runner (spawnSync default maxBuffer) and fails the run with
    // ENOBUFS rather than a useful assertion.
    UtilityParser.initializeScopes None (Some(STLConstants.defaultScopeInputs ()))
    UtilityParser.initializeModifierCategories None (Some(STLConstants.defaultModifiersInputs ()))

    // --- modifiers.log: parsed by StellarisModifierParser in STLGame.fs
    let modifierLog = Path.Combine(dir, "logs", "modifiers.log")
    harness.Check "logs/modifiers.log exists" (File.Exists modifierLog)

    match StellarisModifierParser.parseLogsFile modifierLog with
    | FParsec.CharParsers.ParserResult.Failure(e, _, _) -> harness.Fail("modifiers.log parses", sprintf "%A" e)
    | FParsec.CharParsers.ParserResult.Success(p, _, _) ->
        let mods = StellarisModifierParser.processLogs p
        harness.Check "modifiers.log yields modifiers" (mods.Length > 1000)

        // The bundled modifiers.log is deliberately CURATED, not a mirror of the
        // game log. The project generates most modifier keys at runtime from two
        // channels: CWT type patterns (type[x] = { modifiers = { "a_$_b" = Cat } })
        // and STLValidation.addGeneratedModifiers, and STLGame.fs unions both
        // with embedded.modifiers into lookup.coreModifiers.
        //
        // So the count here must stay small: if it ever jumps toward the game's
        // ~45k entries, someone has replaced the curated list with a log dump,
        // duplicating what the generators already produce.
        harness.Check "modifiers.log stays curated (not a log dump)" (mods.Length < 20000)
        harness.Check "modifiers.log still declares its curated entries" (mods.Length > 1000)

        let names = mods |> List.map (fun m -> m.tag) |> Set.ofList
        harness.Check "ship_hull_mult is declared" (names.Contains "ship_hull_mult")

    // --- trigger_docs.log: parsed by DocsParser in RulesLoader.fs / STLGame.fs
    UtilityParser.initializeScopes None (Some(STLConstants.defaultScopeInputs ()))
    UtilityParser.initializeModifierCategories None (Some(STLConstants.defaultModifiersInputs ()))
    let docsLog = Path.Combine(dir, "logs", "trigger_docs.log")
    harness.Check "logs/trigger_docs.log exists" (File.Exists docsLog)

    match DocsParser.parseDocsFile docsLog with
    | FParsec.CharParsers.ParserResult.Failure(e, _, _) -> harness.Fail("trigger_docs.log parses", sprintf "%A" e)
    | FParsec.CharParsers.ParserResult.Success(p, _, _) ->
        let triggers, effects = DocsParser.processDocs scopeManager.ParseScopes p
        harness.Check "trigger_docs.log yields triggers" (triggers.Length > 1000)
        harness.Check "trigger_docs.log yields effects" (effects.Length > 900)

harness.Summary()