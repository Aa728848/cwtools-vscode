// Phase 0 contract tests for the CWT document pipeline.
//
// Locks in the current observable behavior of the CWT parsing stack
// (CKParser + RulesParser) against the golden corpus in client/test/fixtures/cwt
// BEFORE Phase 2 introduces the dedicated CwtLanguageService. Run from this
// directory:
//
//     dotnet build src/Main/   (fresh CWTools.dll + "CWTools Server.dll")
//     dotnet fsi CwtLanguageService.Tests.fsx
//
// Failing assertions name the fixture, the expected diagnostic/code, and the
// actual observation.

#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/FsPickler.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/Main/debug/CWTools Server.dll"

open System
open System.IO
open FParsec
open CWTools.Common
open CWTools.Parser
open CWTools.Rules

let corpusRoot =
    Path.GetFullPath(Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "client", "test", "fixtures", "cwt"))

let readFixture (relativePath: string) =
    Path.Combine(corpusRoot, relativePath) |> File.ReadAllText

// --- Scope bootstrap -----------------------------------------------------
// The global scopeManager is a mutable singleton; the parser needs at least
// the built-in scopes to classify scope fields.
let scopeInputs =
    [| { ScopeInput.name = "Country"
         aliases = [ "country" ]
         isSubscopeOf = []
         dataTypeName = None }
       { ScopeInput.name = "Planet"
         aliases = [ "planet" ]
         isSubscopeOf = []
         dataTypeName = None }
       { ScopeInput.name = "Leader"
         aliases = [ "leader" ]
         isSubscopeOf = []
         dataTypeName = None } |]

scopeManager.ReInit(scopeInputs, [||])

let parseScope = scopeManager.ParseScope()
let anyScope = scopeManager.AnyScope
let allScopes = scopeManager.AllScopes
let scopeGroups = scopeManager.ScopeGroups

let parseCwt (text: string) (name: string) =
    CKParser.parseString text name

let parseWithMetadata (text: string) (name: string) =
    RulesParser.parseConfigWithMetadata parseScope allScopes anyScope scopeGroups name text

// --- Mini test harness ---------------------------------------------------
let mutable failures = 0

let check (name: string) (condition: bool) =
    if condition then
        printfn "PASS %s" name
    else
        failures <- failures + 1
        printfn "FAIL %s" name

let fail name message =
    failures <- failures + 1
    printfn "FAIL %s: %s" name message

// --- Corpus inventory -----------------------------------------------------
// Any fixture added under client/test/fixtures/cwt must be covered here, so an
// uncatalogued fixture fails loudly instead of silently drifting out of the
// contract.

let listFixtures (subdir: string) =
    Directory.GetFiles(Path.Combine(corpusRoot, subdir), "*.cwt")
    |> Array.map (Path.GetFileName)
    |> Array.sort

let cataloguedValid =
    set
        [ "empty.cwt"
          "only_comments.cwt"
          "shared_root_blocks.cwt"
          "field_expressions.cwt"
          "rule_options.cwt"
          "subtypes.cwt"
          "legacy_blocks.cwt"
          "jomini_blocks.cwt"
          "inject.cwt"
          "inject_target.cwt" ]

let cataloguedInvalid =
    set
        [ "missing_close_brace.cwt"
          "unexpected_token.cwt"
          "incomplete_line.cwt"
          "bad_cardinality.cwt"
          "bad_field_expression.cwt" ]

let cataloguedSemantic =
    set [ "undefined_type_reference.cwt"; "duplicate_definition.cwt" ]

for file in listFixtures "valid" do
    check $"catalog valid/{file}" (Set.contains file cataloguedValid)

for file in listFixtures "invalid" do
    check $"catalog invalid/{file}" (Set.contains file cataloguedInvalid)

for file in listFixtures "semantic" do
    check $"catalog semantic/{file}" (Set.contains file cataloguedSemantic)

// --- valid/: CKParser + RulesParser must succeed --------------------------

let parseAndCheck name expectRulesNonEmpty expectTypesNonEmpty =
    let text = readFixture name
    let parsed = parseCwt text name

    match parsed with
    | Failure(e, _, _) -> fail name $"expected Success, got Failure: %s{e}"
    | Success(_, _, _) ->
        check $"{name}: CKParser Success" true
        let rules, types, enums, _, _, _ = parseWithMetadata text name

        check $"{name}: rules non-empty={expectRulesNonEmpty}" (rules.Length > 0 = expectRulesNonEmpty)
        check $"{name}: types non-empty={expectTypesNonEmpty}" (types.Length > 0 = expectTypesNonEmpty)
        check $"{name}: enums consistent" (enums.Length > 0 = (name = "valid/shared_root_blocks.cwt"))

parseAndCheck "valid/empty.cwt" false false
parseAndCheck "valid/only_comments.cwt" false false
parseAndCheck "valid/shared_root_blocks.cwt" true true
parseAndCheck "valid/field_expressions.cwt" true false
parseAndCheck "valid/rule_options.cwt" true false
// A `types = { ... }`-only file contributes type definitions, not rules.
parseAndCheck "valid/subtypes.cwt" false true
parseAndCheck "valid/legacy_blocks.cwt" true false
// Jomini metadata blocks yield extended metadata; most produce no rules, but
// `override_modes_info` also yields a root rule (empirically observed), so
// rules are non-empty.
parseAndCheck "valid/jomini_blocks.cwt" true false
parseAndCheck "valid/inject.cwt" true false
parseAndCheck "valid/inject_target.cwt" true false

// The metadata blocks themselves must be parsed into ExtendedConfigMetadata:
// priorities and system scopes are consumed there, not as rules.

let jominiText = readFixture "valid/jomini_blocks.cwt"
let _, _, _, _, _, jominiMetadata = parseWithMetadata jominiText "valid/jomini_blocks.cwt"

let priority =
    jominiMetadata.priorities |> Map.tryFind "common/defines"

match priority with
| Some p -> check "valid/jomini_blocks.cwt: priorities parsed" (p.strategy = "LIOS")
| None -> fail "valid/jomini_blocks.cwt" "priorities block did not produce metadata"

check "valid/jomini_blocks.cwt: system_scopes parsed" (jominiMetadata.systemScopes.ContainsKey "This")
check "valid/jomini_blocks.cwt: database_object_types parsed" (jominiMetadata.databaseObjectTypes.ContainsKey "character")
check "valid/jomini_blocks.cwt: on_actions parsed" (jominiMetadata.onActions.ContainsKey "on_game_start")

// --- invalid/: structure errors fail; incomplete input recovers -----------

for file in [ "missing_close_brace.cwt"; "unexpected_token.cwt" ] do
    let name = $"invalid/%s{file}"
    let text = readFixture name

    match parseCwt text name with
    | Failure(_, _, _) -> check $"{name}: CKParser Failure" true
    | Success(_, _, _) -> fail name "expected CKParser Failure for structurally invalid input"

// A trailing incomplete line (cursor mid-expression at EOF) must NOT fail the
// whole file: the parser recovers, the rest of the model stays usable, and
// only the incomplete construct is lost. This is the editor contract behind
// handoff doc §6.3 (no cascading errors from an unfinished current line).
let incompleteText = readFixture "invalid/incomplete_line.cwt"

match parseCwt incompleteText "invalid/incomplete_line.cwt" with
| Failure(e, _, _) -> fail "invalid/incomplete_line.cwt" $"expected lenient recovery, got Failure: %s{e}"
| Success(_, _, _) ->
    check "invalid/incomplete_line.cwt: CKParser recovers" true
    let rules, _, _, _, _, _ =
        parseWithMetadata incompleteText "invalid/incomplete_line.cwt"
    check "invalid/incomplete_line.cwt: completed rules kept" (rules.Length >= 1)

// Baseline record (Phase 0, handoff doc §3.3): these files are syntactically
// legal CWT but carry semantically invalid option/field values. Print the
// observed behavior so it can be pinned in docs/cwt-language-support-baseline.md.

for file in [ "bad_cardinality.cwt"; "bad_field_expression.cwt" ] do
    let name = $"invalid/%s{file}"
    let text = readFixture name

    match parseCwt text name with
    | Failure(e, _, _) -> printfn "BASELINE %s: CKParser Failure (%s)" name e
    | Success(_, _, _) ->
        let rules, _, _, _, _, _ = parseWithMetadata text name
        printfn "BASELINE %s: CKParser Success, rules=%d" name rules.Length

// --- semantic/: syntactically valid, semantically broken ------------------
// These must parse (their diagnostics arrive in Phase 3), and duplicate
// definitions must both be preserved by the parser.

let undefinedText = readFixture "semantic/undefined_type_reference.cwt"

match parseCwt undefinedText "semantic/undefined_type_reference.cwt" with
| Failure(e, _, _) -> fail "semantic/undefined_type_reference.cwt" $"expected Success, got %s{e}"
| Success(_, _, _) ->
    check "semantic/undefined_type_reference.cwt: CKParser Success" true
    let rules, _, _, _, _, _ = parseWithMetadata undefinedText "semantic/undefined_type_reference.cwt"
    check "semantic/undefined_type_reference.cwt: rules non-empty" (rules.Length > 0)

let duplicateText = readFixture "semantic/duplicate_definition.cwt"

match parseCwt duplicateText "semantic/duplicate_definition.cwt" with
| Failure(e, _, _) -> fail "semantic/duplicate_definition.cwt" $"expected Success, got %s{e}"
| Success(_, _, _) ->
    check "semantic/duplicate_definition.cwt: CKParser Success" true
    let _, types, _, _, _, _ = parseWithMetadata duplicateText "semantic/duplicate_definition.cwt"
    check "semantic/duplicate_definition.cwt: both duplicate types kept" (types.Length = 2)

// --- inject: cross-file rule injection -------------------------------------
// `## inject = inject_target.cwt@injected_group/*` must splice the source
// group's children into the target rule's child list.

let sourceText = readFixture "valid/inject_target.cwt"
let targetText = readFixture "valid/inject.cwt"

let injectedRules, _, _, _, _, _ =
    RulesParser.parseConfigs
        parseScope
        allScopes
        anyScope
        scopeGroups
        true
        false
        [ "inject_target.cwt", sourceText
          "inject.cwt", targetText ]

let targetChildren =
    injectedRules
    |> Array.tryPick (function
        | TypeRule("target_block", (NodeRule(_, inner), _)) -> Some inner
        | _ -> None)

match targetChildren with
| None -> fail "inject.cwt" "target_block rule not found after parseConfigs"
| Some children ->
    let names =
        children
        |> Array.choose (function
            | LeafRule(SpecificField(SpecificValue value), _), _ ->
                Some(CWTools.Utilities.StringResource.stringManager.GetStringForID value.normal)
            | _ -> None)
        |> Set.ofArray

    check "inject.cwt: existing child preserved" (Set.contains "existing" names)
    check "inject.cwt: injected child 1 present" (Set.contains "injected1" names)
    check "inject.cwt: injected child 2 present" (Set.contains "injected2" names)

// --- Summary ---------------------------------------------------------------
printfn ""

if failures = 0 then
    printfn "CwtLanguageService.Tests.fsx: all contract checks passed."
    0
else
    printfn "CwtLanguageService.Tests.fsx: %d check(s) FAILED." failures
    1
