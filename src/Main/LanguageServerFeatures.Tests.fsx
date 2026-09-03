#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/Languages.dll"
#r "../../artifacts/bin/Main/debug/LSP.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.DesignTime.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.dll"

#load "../TestHelpers.fsx"

open CWTools.Games
open CWTools.Localisation
open CWTools.Utilities.Position
open Main.Lang.LanguageServerFeatures
open TestHelpers

let private assertEqual name expected actual = assertEqualNamed name expected actual

let private assertContains name (needle: string) (actual: string) =
    if not (actual.Contains needle) then
        failwith $"{name}: expected to contain {needle}, got {actual}"

let private dummyRange = mkRange "localisation/test_l_english.yml" pos0 pos0

let private entry key desc : Entry =
    { key = key
      value = None
      desc = desc
      position = dummyRange
      errorRange = None }

let locMap =
    [ "mod_event.1.name", entry "mod_event.1.name" "Mod Event Name"
      "mod_event.1.desc", entry "mod_event.1.desc" "Mod Event Description" ]

let quotedTitleInfo =
    { typename = "event"
      name = "mod_event.1"
      localisation = [ { key = "title"; value = "\"mod_event.1.name\"" } ]
      ruleDescription = None
      ruleRequiredScopes = [] }

assertEqual
    "quoted symbol localisation"
    (Some "Mod Event Name")
    (lochoverFromInfo locMap (Some quotedTitleInfo) "")

assertEqual
    "quoted direct localisation key"
    (Some "Mod Event Name")
    (lochoverFromInfo locMap None "\"mod_event.1.name\"")

let tableInfo =
    { quotedTitleInfo with
        localisation =
            [ { key = "title"; value = "\"mod_event.1.name\"" }
              { key = "desc"; value = "mod_event.1.desc" } ] }

let tableHover =
    lochoverFromInfo locMap (Some tableInfo) ""
    |> Option.defaultValue ""

assertContains "table quoted title" "Mod Event Name" tableHover
assertContains "table desc" "Mod Event Description" tableHover

printfn "LanguageServerFeatures regression tests passed"
