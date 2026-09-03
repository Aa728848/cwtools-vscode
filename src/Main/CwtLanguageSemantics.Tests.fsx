// Phase 2 semantic tests for the CWT language service (CwtLanguageService).
//
// Table-driven checks for field-expression classification, directive
// validation, declaration shapes, local symbols, and context completion.
// Run from this directory (after `dotnet build src/Main/`):
//
//     dotnet fsi CwtLanguageSemantics.Tests.fsx

#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/Main/debug/CWTools Server.dll"

#load "../TestHelpers.fsx"

open System
open System.IO
open CWTools.CwtLanguage
open CWTools.Utilities.Position
open TestHelpers

let harness = TestHarness("CwtLanguageSemantics.Tests.fsx")
let check = harness.Check
let checkEq = harness.Equal

let corpusRoot =
    Path.GetFullPath(Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "client", "test", "fixtures", "cwt"))

let readFixture (relativePath: string) =
    Path.Combine(corpusRoot, relativePath) |> File.ReadAllText

// --- field-expression classification --------------------------------------

let classified (token: string) =
    match CwtLanguageService.classifyFieldExpression token with
    | CwtLanguageService.Literal -> "literal"
    | CwtLanguageService.KnownField -> "known"
    | CwtLanguageService.UnknownStructured -> "unknown"
    | CwtLanguageService.MalformedKnown name -> "malformed:" + name

let fieldTable =
    [ "bool", "known"
      "int", "known"
      "value_field", "known"
      "value_field[0..inf]", "known"
      "int_value_field[0..inf]", "known"
      "variable_field[-10..10]", "known"
      "int_variable_field_32[0..inf]", "known"
      "int_value_field[1...inf]", "malformed:int_value_field"
      "localisation", "known"
      "int[0..100]", "known"
      "int[-1..inf]", "known"
      "float[0.0..1.0]", "known"
      "enum[species_archetype]", "known"
      "scope[country]", "known"
      "scope_group[celestial_body]", "known"
      "prefix_field[localisation]", "known"
      "single_alias_right[technology_prerequisite]", "known"
      "icon[gfx/interface/icons/buildings]", "known"
      "value[variable]", "known"
      "filename[dds]", "known"
      "$localisation_parameter", "known"
      "$script_value_reference", "known"
      "glob:prefix_*", "known"
      "glob.i:prefix_*", "known"
      "re:^foo$", "known"
      "<sprite>", "known"
      "type[planet_class]", "known"
      "int[0..banana]", "malformed:int"
      "float[1..]", "malformed:float"
      "int[]", "malformed:int"
      "bogus_thing[x]", "unknown"
      "mystery[1]", "unknown"
      "<>", "unknown"
      "$bogus_reference", "unknown"
      "country", "literal"
      "yes", "literal"
      "no", "literal"
      "\"quoted value\"", "literal"
      "42", "literal"
      "-3.5", "literal" ]

for token, expected in fieldTable do
    checkEq $"field {token}" expected (classified token)

// --- directives -------------------------------------------------------------

// Directive validation is exercised through real documents below.

// --- document diagnostics ----------------------------------------------------

let codesOf (text: string) (name: string) =
    CwtLanguageService.analyzeDocument name text
    |> fun r -> r.diagnostics |> List.map (fun d -> d.code) |> Set.ofList

// Valid fixtures must be diagnostic-free.
for fixture in
    [ "valid/only_comments.cwt"
      "valid/shared_root_blocks.cwt"
      "valid/subtypes.cwt"
      "valid/legacy_blocks.cwt"
      "valid/inject.cwt"
      "valid/inject_target.cwt" ] do
    let text = readFixture fixture
    check $"clean {fixture}" (codesOf text fixture |> Set.isEmpty)

// field_expressions.cwt uses only known families; `colour_field` etc. are all
// in the meta-model, so it must stay clean too.
let fieldExprText = readFixture "valid/field_expressions.cwt"
check "clean valid/field_expressions.cwt" (codesOf fieldExprText "valid/field_expressions.cwt" |> Set.isEmpty)

// jomini_blocks.cwt: `## replace_scopes = {...}` is a valid scope-map;
// priorities/systems scopes carry no directives.
let jominiText = readFixture "valid/jomini_blocks.cwt"
check "clean valid/jomini_blocks.cwt" (codesOf jominiText "valid/jomini_blocks.cwt" |> Set.isEmpty)

let badCardinality = readFixture "invalid/bad_cardinality.cwt"
check "bad_cardinality -> CWT102" (codesOf badCardinality "bad_cardinality.cwt" |> Set.contains "CWT102")

let badField = readFixture "invalid/bad_field_expression.cwt"
check "bad_field_expression -> CWT201" (codesOf badField "bad_field_expression.cwt" |> Set.contains "CWT201")

let undefinedDirective =
    "types = {\n\ttype[a] = {\n\t\t## bogus_option = 42\n\t\tpath = \"x\"\n\t}\n}\n"

check "unknown directive -> CWT101" (codesOf undefinedDirective "u.cwt" |> Set.contains "CWT101")

let missingDirectiveValue =
    "types = {\n\ttype[a] = {\n\t\t## required = yes\n\t\tpath = \"x\"\n\t}\n}\n"

check "no-value directive with value -> CWT104" (codesOf missingDirectiveValue "m.cwt" |> Set.contains "CWT104")

let emptyTypeDeclaration = "types = {\n\ttype[] = {\n\t}\n}\n"
check "type[] -> CWT113" (codesOf emptyTypeDeclaration "e.cwt" |> Set.contains "CWT113")

let invalidTypesChild = "types = {\n\tsomething_else = {\n\t}\n}\n"
check "non-type child in types -> CWT110" (codesOf invalidTypesChild "i.cwt" |> Set.contains "CWT110")

let invalidEnumsChild = "enums = {\n\tsomething_else = {\n\t}\n}\n"
check "non-enum child in enums -> CWT111" (codesOf invalidEnumsChild "i.cwt" |> Set.contains "CWT111")

// `## required` is a real (undocumented) option and must stay silent.
let requiredOption = "localisation = {\n\t## required\n\tname = \"$\"\n}\n"
check "## required accepted" (codesOf requiredOption "r.cwt" |> Set.isEmpty)

// `## forbid_quoted_values` accepts a brace list like other list options.
let forbidQuotedValuesOption = "## forbid_quoted_values = { from }\nenabled = bool\n"
check "## forbid_quoted_values accepted" (codesOf forbidQuotedValuesOption "f.cwt" |> Set.isEmpty)

// `##Checks if ...` prose must not be flagged as a directive.
let proseComment = "##Checks if the target is at war\nenabled = bool\n"
check "## prose not flagged" (codesOf proseComment "p.cwt" |> Set.isEmpty)

// CKParser removes the first source '#': only source `##` is a directive;
// source `#` is an ordinary comment and source `###` is documentation.
let commentLevels =
    "# bogus_option = 1\n### capacity = documentation only\nenabled = bool\n"
check "single-hash and triple-hash comments are not directives" (codesOf commentLevels "comments.cwt" |> Set.isEmpty)

// Real Stellaris patterns from country_types.cwt and districts.cwt.
let realRulePatterns =
    "country_type = {\n\tmult = int_value_field[0..inf]\n\tmodifiers = {\n\t\t\"$planet$_build_speed_mult\" = Planets\n\t}\n}\n"
check "bounded dynamic field and quoted dollar key are valid" (codesOf realRulePatterns "real.cwt" |> Set.isEmpty)

// --- symbols ------------------------------------------------------------------

let symbolNames (text: string) kind =
    CwtLanguageService.analyzeDocument "s.cwt" text
    |> fun r ->
        r.document
        |> Option.map (fun d -> d.symbols |> List.filter (fun s -> s.kind = kind) |> List.map (fun s -> s.name) |> Set.ofList)
        |> Option.defaultValue Set.empty

let rootBlocksText = readFixture "valid/shared_root_blocks.cwt"
check "symbol type[planet_class]" (symbolNames rootBlocksText CwtSymbolKind.CwtType |> Set.contains "planet_class")
check "symbol enum[species_archetype]" (symbolNames rootBlocksText CwtSymbolKind.CwtEnum |> Set.contains "species_archetype")
check "symbol complex_enum[building_sets]" (symbolNames rootBlocksText CwtSymbolKind.CwtComplexEnum |> Set.contains "building_sets")
check "symbol alias trigger:has_country_flag" (symbolNames rootBlocksText CwtSymbolKind.CwtAlias |> Set.contains "trigger:has_country_flag")
check "symbol scope Country" (symbolNames rootBlocksText CwtSymbolKind.CwtScope |> Set.contains "Country")
check "symbol scope_group[celestial_body]" (symbolNames rootBlocksText CwtSymbolKind.CwtScopeGroup |> Set.contains "celestial_body")
check "symbol link owner" (symbolNames rootBlocksText CwtSymbolKind.CwtLink |> Set.contains "owner")
check "symbol modifier category Countries" (symbolNames rootBlocksText CwtSymbolKind.CwtModifierCategory |> Set.contains "Countries")

let subtypesText = readFixture "valid/subtypes.cwt"
check "symbol subtype power_plant" (symbolNames subtypesText CwtSymbolKind.CwtSubtype |> Set.contains "power_plant")
check "symbol subtype habitable (shared_root_blocks)" (symbolNames rootBlocksText CwtSymbolKind.CwtSubtype |> Set.contains "habitable")

// --- completion -----------------------------------------------------------------

let labelsAt (text: string) (line: int) (column: int) =
    CwtLanguageService.completeAt "c.cwt" text (mkPos line column)
    |> List.map (fun i -> i.label)

let completeText =
    "types = {\n\ttype[planet_class] = {\n\t\tname_field = \"name\"\n\t}\n}\n\n"

// File root: known root blocks (cursor on the empty line after the block).
let rootLabels = labelsAt completeText 6 0
check "root completion offers types" (rootLabels |> List.contains "types")
check "root completion offers enums" (rootLabels |> List.contains "enums")
check "root completion offers on_actions" (rootLabels |> List.contains "on_actions")

// `## ` -> directive names (empty typed prefix offers all).
let directiveLabels = labelsAt "\n## \n" 2 2
check "directive completion offers cardinality" (directiveLabels |> List.contains "cardinality")
check "directive completion offers severity" (directiveLabels |> List.contains "severity")

// Right side of `= `: field-expression families.
let fieldLabels = labelsAt "enabled = \n" 1 10
check "field completion offers bool" (fieldLabels |> List.contains "bool")
check "field completion offers int" (fieldLabels |> List.contains "int")
check "field completion offers value_field" (fieldLabels |> List.contains "value_field")

// Declaration bracket: local symbols of the kind (file must parse).
let bracketText =
    "types = {\n\ttype[planet_class] = {\n\t}\n\ttype[pl]\n}\n"

let typeBracketLabels = labelsAt bracketText 4 8
check "type[ bracket offers planet_class" (typeBracketLabels |> List.contains "planet_class")

let completionContextText =
    rootBlocksText
    + "\nusage = {\n\tmult = value[variable]\n\tflag = value_set[country_flag]\n}\n"

let completionContext = CwtLanguageService.analyzeDocument "context.cwt" completionContextText
let contextSymbols, contextArguments =
    match completionContext.document with
    | Some document -> document.symbols, document.completionArguments
    | None -> [], []

let projectLabelsAt (text: string) (line: int) (column: int) =
    CwtLanguageService.completeAtWithProjectContext
        "edit.cwt" text (mkPos line column) (Some contextSymbols) (Some contextArguments)
    |> List.map (fun item -> item.label)

let enumReferenceLabels = projectLabelsAt "kind = en\n" 1 9
check "enum completion uses declared enum names" (enumReferenceLabels |> List.contains "enum[species_archetype]")

let typeReferenceLabels = projectLabelsAt "target = <\n" 1 10
check "type completion uses declared type names" (typeReferenceLabels |> List.contains "<planet_class>")

let dynamicReferenceLabels = projectLabelsAt "mult = val\n" 1 10
check "dynamic completion uses observed value namespace" (dynamicReferenceLabels |> List.contains "value[variable]")
check "dynamic completion uses observed value-set namespace" (dynamicReferenceLabels |> List.contains "value_set[country_flag]")
check "dynamic completion does not expose literal x placeholder" (dynamicReferenceLabels |> List.contains "value[x]" |> not)

let aliasReferenceLabels = projectLabelsAt "condition = alias_\n" 1 18
check "alias completion uses declared alias group" (aliasReferenceLabels |> List.contains "alias_name[trigger]")

// Incomplete current line: completion still works (recovery contract).
let incompleteText = "enabled = bool\ncount = int[0..10\n\n"
check "recovery: root completion after incomplete line" (labelsAt incompleteText 3 0 |> List.contains "types")

// Missing close brace: root completion still works at the file start.
let brokenText = "types = {\n\ttype[a] = {\n\t\tpath = \"x\"\n"
check "recovery: root completion with missing brace" (labelsAt brokenText 1 0 |> List.contains "types")

// The canonical Stellaris rule repository is the compatibility corpus for the
// shared CWT dialect. Per-document diagnostics here indicate a language-model
// false positive (project-level undefined/duplicate checks are intentionally
// outside this assertion).
let stellarisConfigRoot =
    Path.GetFullPath(Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "submodules", "cwtools-stellaris-config", "config"))

if Directory.Exists stellarisConfigRoot then
    let corpusDiagnostics =
        Directory.GetFiles(stellarisConfigRoot, "*.cwt", SearchOption.AllDirectories)
        |> Array.sort
        |> Array.collect (fun file ->
            CwtLanguageService.analyzeDocument file (File.ReadAllText file)
            |> fun result -> result.diagnostics |> List.map (fun diagnostic -> file, diagnostic) |> List.toArray)

    for file, diagnostic in corpusDiagnostics |> Array.truncate 100 do
        printfn "CORPUS DIAGNOSTIC %s:%d %s %A" (Path.GetRelativePath(stellarisConfigRoot, file)) diagnostic.range.StartLine diagnostic.code diagnostic.messageArgs

    let isKnownRuleSourceIssue (_, diagnostic: CwtDiagnostic) =
        match diagnostic.code, diagnostic.messageArgs with
        | "CWT201", [ "int_value_field"; "int_value_field[1...inf]" ] -> true
        | "CWT200", [ "value[federation_flag]." ] -> true
        | _ -> false

    let unexpectedCorpusDiagnostics = corpusDiagnostics |> Array.filter (isKnownRuleSourceIssue >> not)
    check "canonical Stellaris CWT corpus has no unexpected single-document diagnostics" (unexpectedCorpusDiagnostics.Length = 0)

// --- rules-parser detailed API -------------------------------------------------

open CWTools.Common
open CWTools.Rules

scopeManager.ReInit([||], [||])
let parseScope = scopeManager.ParseScope()
let anyScope = scopeManager.AnyScope
let allScopes = scopeManager.AllScopes
let scopeGroups = scopeManager.ScopeGroups

let validDetailed =
    RulesParser.parseConfigWithMetadataDetailed
        parseScope
        allScopes
        anyScope
        scopeGroups
        "ok.cwt"
        "types = {\n\ttype[a] = {\n\t\tpath = \"x\"\n\t}\n}\n"

check "detailed API: no parse error on valid input" (validDetailed.parseError.IsNone)
check "detailed API: type model on valid input" (validDetailed.types.Length = 1)

let brokenDetailed =
    RulesParser.parseConfigWithMetadataDetailed parseScope allScopes anyScope scopeGroups "bad.cwt" "types = {\n"

check "detailed API: parse error on broken input" (brokenDetailed.parseError.IsSome)
check "detailed API: empty model on broken input" (brokenDetailed.rules.IsEmpty)

// --- summary ---------------------------------------------------------------------

harness.Summary()
