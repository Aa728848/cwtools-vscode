#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/Main/debug/Microsoft.Data.Sqlite.dll"
#r "../../artifacts/bin/Main/debug/SQLitePCLRaw.core.dll"
#r "../../artifacts/bin/Main/debug/SQLitePCLRaw.batteries_v2.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.DesignTime.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.dll"

#load "../TestHelpers.fsx"

open System
open FSharp.Data
open CWTools.Games
open CWTools.Parser.UtilityParser
open Main.InlineGraph
open TestHelpers

SQLitePCL.Batteries_V2.Init()

let private assertTrue name condition = checkNamed name condition
let private assertEqual name expected actual = assertEqualNamed name expected actual

// ─── inline instantiation graph: template, params, invocation, expansion ────
// Template declares a $TYPE$ top-level block with a $ID$ parameter; four
// invocations with different argument sets must produce four traceable
// expansions, and missing/unused parameters must surface as structured
// problems rather than string-search noise.
let parseEntity (content: string) (filePath: string) : Entity =
    let parsed = CWTools.Parser.CKParser.parseString content filePath
    match parsed with
    | FParsec.CharParsers.Success(files, _, _) ->
        let root = CWTools.Process.STLProcess.simpleProcess.ProcessNode () "root" (CWTools.Utilities.Utils.mkZeroFile filePath) files
        { filepath = filePath
          logicalpath = filePath
          rawEntity = root
          entity = root
          validate = true
          entityType = CWTools.Common.STLConstants.EntityType.Events
          overwrite = CWTools.Games.Overwrite.No }
    | _ -> failwith $"failed to parse {filePath}"

let templateContent = """$TYPE$ = {
    id = $ID$
    name = $NAME$
    desc = $LOC$
}
"""

let caller1 = """country_event = {
    id = caller.1
    effect = {
        inline_script = common/inline_scripts/template_def
        inline_script = { script = common/inline_scripts/template_def TYPE = country_event ID = expanded.one NAME = First LOC = expanded_one_desc }
        inline_script = { script = common/inline_scripts/template_def TYPE = country_event ID = expanded.two }
        inline_script = { script = common/inline_scripts/template_def TYPE = country_event ID = expanded.one NAME = Duplicate }
        inline_script = { script = common/inline_scripts/template_def TYPE = country_event ID = bad/id NAME = Invalid }
        inline_script = missing_template_path
        inline_script = { TYPE = country_event ID = missing.script }
    }
}
"""

let templateEntity = parseEntity templateContent "common/inline_scripts/template_def.txt"
let callerEntity = parseEntity caller1 "events/caller1.txt"

let facts = collectInlineGraph [ struct (templateEntity, ()); struct (callerEntity, ()) ]
let unrelatedEntity = parseEntity "country_event = { id = unrelated.1 }" "events/unrelated.txt"

assertTrue "inline relevance detects callers" (containsInlineInvocation callerEntity.rawEntity)
assertEqual "inline relevance skips unrelated files" false (containsInlineInvocation unrelatedEntity.rawEntity)
assertEqual "empty inline graph facts stay empty" 0 emptyInlineGraphFacts.invocations.Length
assertEqual "one template indexed" 1 facts.templates.Length
assertEqual "template logical path normalized" "common/inline_scripts/template_def.txt" facts.templates.Head.logicalPath
assertEqual "seven invocations indexed" 7 facts.invocations.Length
assertTrue "parameters retain their owning template"
    (facts.parameters.Length = 4
     && facts.parameters |> List.forall (fun item -> item.templateId = "template_def"))
assertTrue "parameter type comes from syntactic field context"
    (facts.parameters |> List.exists (fun item -> item.name = "LOC" && item.inferredType = "localisation_key"))
assertTrue "arguments expose their resolved value"
    (facts.arguments |> List.exists (fun item -> item.name = "LOC" && item.resolvedValue = "expanded_one_desc"))

let expansions = facts.expansions |> List.map (fun item -> item.expandedSymbolId) |> List.sort
assertTrue "expanded top-level symbol is traceable to an invocation"
    (expansions |> List.contains "expanded.one" && expansions |> List.contains "expanded.two")
assertTrue "expanded.one is used as the generated definition id"
    (facts.expansions |> List.exists (fun item -> item.expandedSymbolId = "expanded.one" && item.entityType = "event" && item.templateFile.EndsWith("template_def.txt")))
assertTrue "generated localisation references retain template and caller source maps"
    (facts.generatedReferences |> List.exists (fun item -> item.referenceKind = "localisation" && item.expandedValue = "expanded_one_desc" && item.callerFile.EndsWith("caller1.txt")))

let flowTemplateContent = """set_country_flag = $FLAG$
carrier_event = { id = $EVENT$ }
"""
let flowCallerContent = """carrier_event = {
    id = caller.1
    inline_script = { script = tests/flow FLAG = ready EVENT = target.1 }
}
"""
let flowTemplate = parseEntity flowTemplateContent "common/inline_scripts/tests/flow.txt"
let flowCaller = parseEntity flowCallerContent "events/flow_caller.txt"
let flowFacts = collectInlineGraph [ struct (flowTemplate, ()); struct (flowCaller, ()) ]
assertTrue "inline caller is attributed to its event id"
    (flowFacts.invocations |> List.exists (fun item -> item.enclosingDefinition = Some "caller.1"))
assertTrue "inline state access is rendered"
    (flowFacts.generatedReferences |> List.exists (fun item -> item.referenceKind = "state:set:country" && item.expandedValue = "ready"))
assertTrue "new event subtypes are rendered without a static allowlist"
    (flowFacts.generatedReferences |> List.exists (fun item -> item.referenceKind = "event" && item.expandedValue = "target.1"))
assertTrue "missing-parameter invocation produces a structured problem"
    (facts.problems |> List.exists (fun item -> item.kind = "missing_parameter" && item.message.Contains "NAME"))
assertTrue "unresolved template produces a structured problem"
    (facts.problems |> List.exists (fun item -> item.kind = "unresolved_template"))
assertTrue "missing-script form produces a structured problem"
    (facts.problems |> List.exists (fun item -> item.kind = "missing_script"))
assertTrue "invalid expanded identifier produces a structured problem"
    (facts.problems |> List.exists (fun item -> item.kind = "invalid_identifier"))
assertTrue "duplicate expanded definition is reported at its calls"
    (facts.problems |> List.filter (fun item -> item.kind = "duplicate_expansion") |> List.length >= 2)

let callerQuery =
    { template = None
      callerFile = Some "events/caller1.txt"
      callerLine = Some facts.invocations.Head.callerLine
      limit = 10 }
let callerFacts, callerTruncated, callerConsidered = filterInlineGraph callerQuery facts
assertEqual "file and line query returns one invocation" 1 callerFacts.invocations.Length
assertEqual "file and line query considered one invocation" 1 callerConsidered
assertEqual "file and line query is not truncated" false callerTruncated

let templateQuery =
    { template = Some "common/inline_scripts/template_def.txt"
      callerFile = None
      callerLine = None
      limit = 2 }
let templateFacts, templateTruncated, templateConsidered = filterInlineGraph templateQuery facts
assertEqual "template query is server bounded" 2 templateFacts.invocations.Length
assertEqual "template query sees every caller" 5 templateConsidered
assertEqual "template query reports truncation" true templateTruncated

let json = inlineGraphJson facts
assertEqual "json ok flag" true (json.Item("ok").AsBoolean())
assertTrue "json exposes templates, invocations and expansions"
    (json.Item("templates").AsArray().Length = 1
     && json.Item("invocations").AsArray().Length = 7
     && json.Item("expansions").AsArray().Length >= 2)

// Determinism: identical input produces identical output.
let factsAgain = collectInlineGraph [ struct (templateEntity, ()); struct (callerEntity, ()) ]
assertEqual "inline graph is deterministic"
    (facts.expansions |> List.sortBy (fun item -> item.expandedSymbolId) |> List.map (fun item -> item.expandedSymbolId))
    (factsAgain.expansions |> List.sortBy (fun item -> item.expandedSymbolId) |> List.map (fun item -> item.expandedSymbolId))

let recursiveAContent = """inline_script = common/inline_scripts/recursive_b
alpha = { id = alpha }
"""
let recursiveBContent = """inline_script = common/inline_scripts/recursive_a
beta = { id = beta }
"""
let recursiveA = parseEntity recursiveAContent "common/inline_scripts/recursive_a.txt"
let recursiveB = parseEntity recursiveBContent "common/inline_scripts/recursive_b.txt"
let recursiveFacts = collectInlineGraph [ struct (recursiveA, ()); struct (recursiveB, ()) ]
assertTrue "template recursion is reported without recursive expansion"
    (recursiveFacts.problems |> List.exists (fun item -> item.kind = "recursive_template"))

let child = parseEntity """child_event = { id = $CHILD$ desc = $CHILD_LOC$ }""" "common/inline_scripts/child.txt"
let parent = parseEntity """inline_script = { script = common/inline_scripts/child CHILD = $ROOT$_child CHILD_LOC = $ROOT$_child_desc }""" "common/inline_scripts/parent.txt"
let transitiveCaller = parseEntity """country_event = { id = caller.2 inline_script = { script = common/inline_scripts/parent ROOT = generated } }""" "events/transitive.txt"
let transitiveFacts = collectInlineGraph [ struct (child, ()); struct (parent, ()); struct (transitiveCaller, ()) ]
assertTrue "transitive inline expansion reaches nested templates"
    (transitiveFacts.expansions |> List.exists (fun item -> item.expandedSymbolId = "generated_child" && item.confidence = "transitive_expanded"))
let childQuery = { template = Some "child"; callerFile = None; callerLine = None; limit = 20 }
let childFacts, _, _ = filterInlineGraph childQuery transitiveFacts
assertTrue "template query includes indirect external callers"
    (childFacts.invocations |> List.exists (fun item -> item.callerFile.EndsWith("transitive.txt")))

let cancellationObserved =
    try
        collectInlineGraphCancellable (fun () -> true) [ struct (templateEntity, ()) ] |> ignore
        false
    with :? System.OperationCanceledException -> true
assertTrue "inline graph honors cancellation before scanning" cancellationObserved

printfn "InlineGraph instantiation regression tests passed"
