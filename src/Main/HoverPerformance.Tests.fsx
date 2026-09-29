#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/Languages.dll"
#r "../../artifacts/bin/Main/debug/LSP.dll"

#load "../TestHelpers.fsx"

open Main.Lang.HoverPerformance
open TestHelpers

let harness = TestHarness("HoverPerformance")

let english (word: string) (entry: Fact) = describe (fun en _ -> en) { entry with Command = word }
let chinese (word: string) (entry: Fact) = describe (fun _ zh -> zh) { entry with Command = word }

// --- cost-class vocabulary (the values accepted by ## cost = ...) ----------

let parseCases =
    [ "o(1)", Constant
      "constant", Constant
      "O(1)", Constant
      "o(log n)", Logarithmic
      "logarithmic", Logarithmic
      "o(n)", LinearContainer
      "linear", LinearContainer
      "o(n)_owned", LinearOwned
      "o(n)_galaxy", LinearGalaxy
      "o(n^2)", Quadratic
      "quadratic", Quadratic
      "combat", CombatScale
      "refresh_batch", RefreshBatch
      "load", LoadScale
      "semantics", Quirk
      "script_eval", ScriptEval
      "scope_copy", ScopeCopy ]

for (raw, expected) in parseCases do
    harness.Equal (sprintf "## cost = %s parses" raw) (Some expected) (tryParseClass raw)

harness.Equal "case and padding are tolerated" (Some LinearContainer) (tryParseClass "  O(N)  ")
harness.Equal "quoted value is tolerated" (Some Constant) (tryParseClass "\"o(1)\"")
harness.Check "unknown cost value yields None" (tryParseClass "fast" |> Option.isNone)
harness.Check "empty cost value yields None" (tryParseClass "" |> Option.isNone)
harness.Check "whitespace cost value yields None" (tryParseClass "   " |> Option.isNone)

// every class must round-trip through its token
let allClasses =
    [ Constant; Logarithmic; LinearContainer; LinearOwned; LinearGalaxy; Quadratic; CombatScale; RefreshBatch; LoadScale; Quirk; ScriptEval; ScopeCopy ]

for cls in allClasses do
    harness.Equal (sprintf "class token round-trips (%A)" cls) (Some cls) (tryParseClass (classToken cls))

// --- the complexity symbol is fixed per class, so it can be asserted -------

let symbolOf cls =
    let text = english "x" (fromRule "x" cls None None)
    text.Split('\n').[0]

harness.Check "Constant renders O(1)" ((symbolOf Constant).Contains "`O(1)`")
harness.Check "Logarithmic renders O(log n)" ((symbolOf Logarithmic).Contains "`O(log n)`")
harness.Check "LinearContainer renders O(n)" ((symbolOf LinearContainer).Contains "`O(n)`")
harness.Check "LinearOwned renders O(n)" ((symbolOf LinearOwned).Contains "`O(n)`")
harness.Check "Quadratic renders O(n^2)" ((symbolOf Quadratic).Contains "`O(n^2)`")
harness.Check "CombatScale renders O(combatants)" ((symbolOf CombatScale).Contains "`O(combatants)`")
harness.Check "RefreshBatch renders the saved refresh" ((symbolOf RefreshBatch).Contains "saved refresh")
harness.Check "LoadScale renders load time" ((symbolOf LoadScale).Contains "`load time`")
harness.Check "Quirk renders semantics" ((symbolOf Quirk).Contains "`semantics`")
harness.Check "ScriptEval renders eval" ((symbolOf ScriptEval).Contains "`eval`")
harness.Check "ScopeCopy renders scope copy" ((symbolOf ScopeCopy).Contains "scope copy")

// --- evidence handling -----------------------------------------------------

let verified =
    fromRule "num_ships" LinearOwned (Some "Sums the ship container.") (Some "CFleet::CalcNumShips; dump L3222945")

let verifiedText = english "num_ships" verified
harness.Check "verified fact shows the mechanism" (verifiedText.Contains "**Hardcoded behaviour**: Sums the ship container.")
harness.Check "verified fact shows the evidence line" (verifiedText.Contains "**Engine evidence**: CFleet::CalcNumShips; dump L3222945")
harness.Check "verified fact omits the unverified marker" (not (verifiedText.Contains "**Verification**:"))

let hint = fromRule "has_civic" LinearContainer None None
let hintText = english "has_civic" hint
harness.Check "fact without evidence states it is unconfirmed" (hintText.Contains "**Verification**: not confirmed")
harness.Check "fact without evidence omits the evidence line" (not (hintText.Contains "**Engine evidence**:"))
harness.Check "fact without mechanism omits the mechanism line" (not (hintText.Contains "**Hardcoded behaviour**:"))
harness.Check "fact without mechanism still shows the cost" (hintText.Contains "**Engine cost**")

// --- localisation ----------------------------------------------------------

let zh = chinese "num_ships" verified
harness.Check "chinese hover localises the cost label" (zh.Contains "**引擎开销**")
harness.Check "chinese hover localises the mechanism label" (zh.Contains "**硬编码行为**")
harness.Check "chinese hover localises the evidence label" (zh.Contains "**引擎证据**")
harness.Check "chinese hover localises the unverified label" ((chinese "x" hint).Contains "**验证状态**")

// --- resolve: rule-declared fact wins, family fallback otherwise -----------

let declared = fromRule "has_country_flag" LinearContainer (Some "rule-declared") (Some "rule evidence")

let ruleLookup (name: string) =
    if name = "has_country_flag" then Some declared else None

harness.Equal
    "rule-declared fact is used for the exact command"
    (Some "rule-declared")
    (resolve ruleLookup "has_country_flag" |> Option.bind (fun f -> f.Mechanism))

harness.Equal
    "rule-declared class is preserved"
    (Some LinearContainer)
    (resolve ruleLookup "has_country_flag" |> Option.map (fun f -> f.Class))

let flagFallback = resolve (fun _ -> None) "has_ship_flag" |> Option.map (fun f -> f.Class)
harness.Equal "unannotated flag command falls back to the family rule" (Some LinearContainer) flagFallback

let ownedFallback = resolve (fun _ -> None) "num_owned_planets" |> Option.map (fun f -> f.Class)
harness.Equal "unannotated num_owned_ command falls back to the family rule" (Some LinearOwned) ownedFallback

harness.Check "unrelated command has no annotation" (resolve (fun _ -> None) "if" |> Option.isNone)
harness.Check "empty word has no annotation" (resolve (fun _ -> None) "" |> Option.isNone)
harness.Check "whitespace word has no annotation" (resolve (fun _ -> None) "   " |> Option.isNone)

// word normalisation mirrors the hover path (quotes and @ are stripped)
harness.Equal
    "quoted word is normalised before lookup"
    (Some Constant)
    (resolve (fun name -> if name = "has_tradition" then Some(fromRule name Constant None None) else None) "\"has_tradition\""
     |> Option.map (fun f -> f.Class))

harness.Equal
    "variable word is normalised before lookup"
    (Some Constant)
    (resolve (fun name -> if name = "tier1materialmin" then Some(fromRule name Constant None None) else None) "@tier1materialmin"
     |> Option.map (fun f -> f.Class))

harness.Summary() |> ignore
