#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/Languages.dll"
#r "../../artifacts/bin/Main/debug/LSP.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.DesignTime.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.dll"

#load "../TestHelpers.fsx"

open System
open CWTools.Common
open Main.Lang.GameLoader
open TestHelpers

let private assertEqual name expected actual = assertEqualNamed name expected actual
let private assertTrue name condition = checkNamed name condition

let langTag = function
    | Lang.STL l -> $"STL.{l}"
    | Lang.EU4 l -> $"EU4.{l}"
    | Lang.HOI4 l -> $"HOI4.{l}"
    | Lang.CK2 l -> $"CK2.{l}"
    | Lang.IR l -> $"IR.{l}"
    | Lang.VIC2 l -> $"VIC2.{l}"
    | Lang.CK3 l -> $"CK3.{l}"
    | Lang.VIC3 l -> $"VIC3.{l}"
    | Lang.EU5 l -> $"EU5.{l}"
    | Lang.Custom l -> $"Custom.{l}"

let tags (langs: Lang array) = langs |> Array.map langTag |> Array.toList

// ─── language derivation ────────────────────────────────────────────────────
// Regression: when the client never sends `localisation.languages` (or the
// loaded game differs from the configured one, e.g. Stellaris without vanilla
// data degrading to the generic game), an empty or mismatched Lang set made
// the game parse zero localisation keys. The parsed set must always be
// derived from the raw config names for the game that actually loads.

// No preference -> game default language, never an empty set.
assertEqual "STL default" [ "STL.English" ] (tags (parseLanguagesForGame GameLanguage.STL [||]))
assertEqual "Custom default" [ "Custom.English" ] (tags (parseLanguagesForGame GameLanguage.Custom [||]))
assertEqual "EU4 default" [ "EU4.English" ] (tags (parseLanguagesForGame GameLanguage.EU4 [||]))

// Explicit names parse for the requested game (tags follow the game, not the name).
assertEqual "Custom english by name" [ "Custom.English" ] (tags (parseLanguagesForGame GameLanguage.Custom [| "English" |]))
assertEqual "STL multi" [ "STL.English"; "STL.Chinese" ] (tags (parseLanguagesForGame GameLanguage.STL [| "English"; "Chinese" |]))
assertEqual "Custom multi" [ "Custom.English"; "Custom.Chinese" ] (tags (parseLanguagesForGame GameLanguage.Custom [| "English"; "Chinese" |]))

// Unknown names fall back to the game's English, never crash.
assertEqual "STL unknown" [ "STL.English" ] (tags (parseLanguagesForGame GameLanguage.STL [| "klingon" |]))

// ─── end-to-end: localisation keys load for the actual game ─────────────────
// The sample workspace ships localisation files; with a language set that
// matches the loaded game, CWTools must parse keys (the localisation hover
// depends on it). Uses the generic game so it runs without a Stellaris
// install or vanilla cache (mirrors the CI degradation path).
let sampleRoot =
    let dir = System.IO.Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "client", "test", "sample")
    System.IO.Path.GetFullPath dir

if System.IO.Directory.Exists sampleRoot then
    let rulesRoot =
        System.IO.Path.GetFullPath(System.IO.Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "submodules", "cwtools-stellaris-config", "config"))

    if System.IO.Directory.Exists rulesRoot then
        let settings =
            { cachePath = None
              bundledRulesPath = None
              preferBundledRules = true
              useManualRules = true
              manualRulesFolder = Some rulesRoot
              isVanillaFolder = false
              path = sampleRoot
              workspaceFolders = []
              dontLoadPatterns = [||]
              validateVanilla = false
              languages = parseLanguagesForGame GameLanguage.Custom [||]
              experimental = false
              debug_mode = false
              maxFileSize = 50
              stlVanillaPath = None }

        let game: CWTools.Games.IGame<CWTools.Games.JominiComputedData> = loadCustom settings
        let refs = game.References()
        assertTrue "custom game parses localisation keys" (refs.Localisation.Length > 0)
        printfn "custom game localisation keys: %d" refs.Localisation.Length
    else
        printfn "SKIP end-to-end: rules folder missing at %s" rulesRoot
else
    printfn "SKIP end-to-end: sample workspace missing at %s" sampleRoot

printfn "LocalisationLanguages.Tests.fsx PASS"
