module Main.PdxFlowAnalysis

open System
open System.Collections.Generic
open System.Text.RegularExpressions
open FSharp.Data
open CWTools.Games
open CWTools.Process

/// Static cost model and gameplay-relationship analysis.
///
/// Cost model: every_*/random_*/ordered_* traversals, while loops, pulse
/// handlers and nested fan-out get an explainable relative cost with the
/// triggering frequency and traversal range that drive it. No attempt is made
/// to predict real game runtime.
///
/// Gameplay relations: technology prerequisites, special project success/fail
/// events, megastructure upgrade chains and component -> section template
/// wiring are extracted as directed typed edges with source locations.

type CostFact =
    { kind: string
      name: string
      scope: string
      phase: string
      nestingDepth: int
      frequency: string
      traversalRange: string
      amplification: string
      file: string
      line: int
      confidence: string }

type GameplayRelationFact =
    { relationType: string
      sourceId: string
      targetId: string
      sourceType: string
      targetType: string
      file: string
      line: int
      confidence: string
      provenance: string }

type FlowIssueFact =
    { kind: string
      severity: string
      definitionId: string
      subject: string
      message: string
      file: string
      line: int
      confidence: string
      provenance: string }

type FlowAnalysisFacts =
    { costs: CostFact list
      relations: GameplayRelationFact list
      issues: FlowIssueFact list
      filesConsidered: int
      definitionsConsidered: int
      truncated: bool }

type FlowQuery =
    { file: string option
      definitionId: string option
      entityType: string option
      limit: int }

let private normalizePath (value: string) =
    value.Replace('\\', '/').Trim().TrimStart('/').ToLowerInvariant()

let private jsonRecord fields = fields |> List.choose id |> List.toArray |> JsonValue.Record
let private jsonStringArray values = values |> Seq.map JsonValue.String |> Seq.toArray |> JsonValue.Array

/// Cost weights are relative, not runtime predictions: a galaxy traversal is
/// more expensive than a country one, a while loop more than a bounded if.
let private traversalWeight =
    dict [
        "galaxy", 100
        "country", 30
        "system", 15
        "planet", 12
        "fleet", 8
        "ship", 6
        "pop", 4
        "army", 4
        "starbase", 6
        "megastructure", 8
        "ambient_object", 5
        "deposit", 4
        "strategic_region", 5
        "trade_route", 5
        "all", 50
        "any", 30
        "random", 25
        "ordered", 20
        "limit", 10
    ]

let private scopeOfOperator (name: string) =
    let lower = name.ToLowerInvariant()
    let mutable scope = "any"
    for KeyValue(key, weight) in traversalWeight do
        if lower.Contains("_" + key) || lower.StartsWith(key + "_") || lower.Contains(key + "_") then
            if weight >= (if traversalWeight.ContainsKey scope then traversalWeight.[scope] else 0) then
                scope <- key
    scope

let private frequencyOf (node: Node) =
    let key = node.Key.ToLowerInvariant()
    if key.Contains "on_daily" then "daily"
    elif key.Contains "on_monthly" then "monthly"
    elif key.Contains "on_yearly" then "yearly"
    elif key.Contains "on_quarterly" then "quarterly"
    elif key.Contains "on_actions" then "on_action_triggered"
    elif key = "while" then "per_tick_while_running"
    else "event_or_effect"

let private phaseOf (node: Node) =
    let key = node.Key.ToLowerInvariant()
    if key = "trigger" then "trigger"
    elif key = "immediate" then "immediate"
    elif key = "option" then "option"
    elif key = "hidden_effect" then "hidden_effect"
    elif key = "after" then "after"
    elif key = "on_success" then "on_success"
    elif key = "on_fail" then "on_fail"
    elif key = "potential" then "potential"
    elif key = "allow" then "allow"
    else ""

let private isTraversal (key: string) =
    let lower = key.ToLowerInvariant()
    lower.StartsWith("every_") || lower.StartsWith("random_") || lower.StartsWith("ordered_")
    || lower = "while" || lower.StartsWith("limit:")

let private isPulseHandler (key: string) =
    let lower = key.ToLowerInvariant()
    lower.Contains "on_daily" || lower.Contains "on_monthly" || lower.Contains "on_yearly"
    || lower.Contains "on_quarterly"

let private eventCallOperators =
    [ "country_event"; "fleet_event"; "ship_event"; "planet_event"; "system_event"
      "starbase_event"; "megastructure_event"; "pop_event"; "army_event"; "ambient_object_event"
      "any_country_event"; "any_planet_event"; "any_system_event"; "fire_on_action" ]
    |> Set.ofList

let private whileAmplification (node: Node) =
    let rec descendants (current: Node) =
        seq {
            yield current
            for child in current.Nodes do
                yield! descendants child
        }
    let nodes = descendants node |> Seq.toList
    let keys =
        nodes
        |> Seq.collect (fun current ->
            seq {
                yield current.Key.ToLowerInvariant()
                for value in current.Values do yield value.Key.ToLowerInvariant()
            })
        |> Set.ofSeq
    let hasVisibleBound =
        keys.Contains "limit" || keys.Contains "count" || keys.Contains "max_iterations"
        || keys |> Seq.exists (fun key -> key.StartsWith("num_", StringComparison.Ordinal))
    let hasVisibleProgress =
        keys.Contains "change_variable" || keys.Contains "subtract_variable"
        || keys.Contains "set_variable" || keys.Contains "remove_variable"
        || keys.Contains "clear_variable"
    if hasVisibleBound && hasVisibleProgress then "bounded_or_progressing_loop"
    elif hasVisibleProgress then "progress_visible_loop"
    else "potential_unbounded_loop"

/// Collect cost facts from one AST root, tracking nesting depth and phase.
let collectCosts (root: Node) (file: string) =
    let costs = ResizeArray<CostFact>()
    let mutable depth = 0
    let rec visit (node: Node) (phase: string) =
        let key = node.Key.ToLowerInvariant()
        let childPhase = if phaseOf node <> "" then phaseOf node else phase
        let isTraversalNode = isTraversal key
        let isPulseNode = isPulseHandler key
        if isTraversalNode || isPulseNode then
            let scope = if isTraversalNode then scopeOfOperator key else "pulse"
            let traversal =
                if isTraversalNode then
                    let mutable best = "any"
                    for KeyValue(candidate, weight) in traversalWeight do
                        if key.Contains("_" + candidate) && weight >= (if traversalWeight.ContainsKey best then traversalWeight.[best] else 0) then
                            best <- candidate
                    best
                else "pulse"
            let amplification =
                if key = "while" then whileAmplification node
                elif traversal = "galaxy" then "galaxy_wide"
                elif traversal = "country" then "country_wide"
                elif depth > 1 then sprintf "nested_depth_%d" depth
                else "single_level"
            costs.Add
                { kind = if isPulseNode then "pulse_handler" else "traversal"
                  name = node.Key
                  scope = scope
                  phase = childPhase
                  nestingDepth = depth
                  frequency = frequencyOf node
                  traversalRange = traversal
                  amplification = amplification
                  file = file
                  line = int node.Position.StartLine
                  confidence = "heuristic-static" }
            depth <- depth + 1
        for child in node.Nodes do
            visit child childPhase
        if isTraversalNode || isPulseNode then depth <- max 0 (depth - 1)
    visit root ""
    costs |> Seq.toList

/// Collect gameplay relations from a definition root.
let collectRelations (root: Node) (file: string) (definitionId: string) (definitionType: string) =
    let relations = ResizeArray<GameplayRelationFact>()
    let addRelation relationType targetId targetType line =
        if not (String.IsNullOrWhiteSpace targetId) then
            relations.Add
                { relationType = relationType
                  sourceId = definitionId
                  targetId = targetId
                  sourceType = definitionType
                  targetType = targetType
                  file = file
                  line = line
                  confidence = "heuristic"
                  provenance = "declared-field-heuristic" }
    let rec visit (node: Node) =
        let key = node.Key.ToLowerInvariant()
        for value in node.Values do
            let valueKey = value.Key.ToLowerInvariant()
            let target = string value.Value |> fun raw -> raw.Trim().Trim('"')
            if valueKey = "upgrades_to" || valueKey = "next_upgrade" then
                addRelation "megastructure_upgrades_to" target "megastructure" (int value.Position.StartLine)
            elif valueKey = "require_component" || valueKey = "required_component" then
                addRelation "section_requires_component" target "component" (int value.Position.StartLine)
            elif valueKey = "ship_size" then
                addRelation "design_uses_ship_size" target "ship_size" (int value.Position.StartLine)
            elif (valueKey = "component" || valueKey = "component_template")
                 && (definitionType.ToLowerInvariant().Contains "section" || definitionType.ToLowerInvariant().Contains "ship_design") then
                addRelation "ship_structure_uses_component" target "component" (int value.Position.StartLine)
            elif definitionType.ToLowerInvariant().Contains "situation" && valueKey = "stage" then
                addRelation "situation_uses_stage" target "situation_stage" (int value.Position.StartLine)
            elif definitionType.ToLowerInvariant().Contains "situation" && valueKey = "approach" then
                addRelation "situation_uses_approach" target "situation_approach" (int value.Position.StartLine)
            elif definitionType.ToLowerInvariant().Contains "situation" && valueKey = "progress" && not (Regex.IsMatch(target, "^-?[0-9.]+$")) then
                addRelation "situation_reads_progress_value" target "scripted_value" (int value.Position.StartLine)
            elif definitionType.ToLowerInvariant().Contains "situation" && valueKey.EndsWith("_event", StringComparison.Ordinal) then
                addRelation "situation_fires_event" target "event" (int value.Position.StartLine)
            elif definitionType.ToLowerInvariant().Contains "scripted_value" && valueKey.Contains "modifier" then
                addRelation "scripted_value_reads_modifier" target "modifier" (int value.Position.StartLine)
        // Bare value lists (e.g. `prerequisites = { "a" "b" }`) parse as
        // LeafValueC children; collect them via LeafValues with their position.
        let bareValues =
            node.LeafValues
            |> Seq.map (fun value -> value.Key, int value.Position.StartLine)
            |> Seq.toList
        if key = "prerequisites" && (definitionType.ToLowerInvariant().Contains "technology" || definitionType.ToLowerInvariant().Contains "situation") then
            for value, line in bareValues do
                addRelation "prerequisite_of" value "technology" line
        elif key = "on_success" && definitionType.ToLowerInvariant().Contains "special_project" then
            if not bareValues.IsEmpty then
                for value, line in bareValues do
                    addRelation "special_project_success_event" value "event" line
            else
                // on_success = { country_event = { id = X } }
                for eventNode in node.Nodes do
                    if eventCallOperators.Contains(eventNode.Key.ToLowerInvariant()) then
                        for leaf in eventNode.Values do
                            if leaf.Key.Equals("id", StringComparison.OrdinalIgnoreCase) then
                                addRelation "special_project_success_event" (string leaf.Value) "event" (int leaf.Position.StartLine)
        elif key = "on_fail" && definitionType.ToLowerInvariant().Contains "special_project" then
            if not bareValues.IsEmpty then
                for value, line in bareValues do
                    addRelation "special_project_fail_event" value "event" line
            else
                for eventNode in node.Nodes do
                    if eventCallOperators.Contains(eventNode.Key.ToLowerInvariant()) then
                        for leaf in eventNode.Values do
                            if leaf.Key.Equals("id", StringComparison.OrdinalIgnoreCase) then
                                addRelation "special_project_fail_event" (string leaf.Value) "event" (int leaf.Position.StartLine)
        elif key = "upgrades_to" || key = "next_upgrade" then
            for value, line in bareValues do
                addRelation "megastructure_upgrades_to" value "megastructure" line
        elif key = "require_component" || key = "required_component" then
            for value, line in bareValues do
                addRelation "section_requires_component" value "component" line
        elif key = "ship_size" then
            for value, line in bareValues do
                addRelation "design_uses_ship_size" value "ship_size" line
        elif (key = "component" || key = "component_template")
             && (definitionType.ToLowerInvariant().Contains "section" || definitionType.ToLowerInvariant().Contains "ship_design") then
            for value, line in bareValues do
                addRelation "ship_structure_uses_component" value "component" line
        elif definitionType.ToLowerInvariant().Contains "situation" && key = "stages" then
            for value, line in bareValues do
                addRelation "situation_uses_stage" value "situation_stage" line
        elif definitionType.ToLowerInvariant().Contains "situation" && key = "approaches" then
            for value, line in bareValues do
                addRelation "situation_uses_approach" value "situation_approach" line
        for child in node.Nodes do
            visit child
    visit root
    relations |> Seq.toList

type private StateAccess =
    { operation: string
      subject: string
      scope: string
      line: int
      conditional: bool
      phase: string }

type private EventCall =
    { sourceId: string
      targetId: string
      operator: string
      file: string
      line: int
      delayed: bool }

let private stateOperation (key: string) =
    let lower = key.ToLowerInvariant()
    if lower.StartsWith("save_") && lower.Contains("event_target") then Some "save"
    elif lower.StartsWith("set_") && (lower.Contains("variable") || lower.EndsWith("_flag")) then Some "set"
    elif lower.StartsWith("change_") && lower.Contains("variable") then Some "write"
    elif (lower.StartsWith("remove_") || lower.StartsWith("clear_")) && (lower.Contains("variable") || lower.Contains("flag") || lower.Contains("event_target")) then Some "clear"
    elif (lower.StartsWith("has_") || lower.StartsWith("check_") || lower.StartsWith("is_")) && (lower.Contains("variable") || lower.Contains("flag") || lower.Contains("event_target")) then Some "read"
    else None

let private stateScope (key: string) =
    let lower = key.ToLowerInvariant()
    if lower.Contains "global_event_target" then "global"
    elif lower.Contains "event_target" then "local_event"
    elif lower.Contains "country" then "country"
    elif lower.Contains "planet" then "planet"
    elif lower.Contains "fleet" then "fleet"
    elif lower.Contains "ship" then "ship"
    elif lower.Contains "system" then "system"
    elif lower.Contains "pop" then "pop"
    else "current_scope"

let private subjectFromNode (node: Node) =
    let preferred = Set.ofList [ "which"; "name"; "flag"; "id"; "target" ]
    node.Values
    |> Seq.tryFind (fun value -> preferred.Contains(value.Key.ToLowerInvariant()))
    |> Option.orElseWith (fun () -> node.Values |> Seq.tryHead)
    |> Option.map (fun value -> string value.Value |> fun raw -> raw.Trim().Trim('"'))
    |> Option.defaultValue "<dynamic>"

let private collectStateAccesses (root: Node) =
    let accesses = ResizeArray<StateAccess>()
    let rec visit (node: Node) conditional phase =
        let key = node.Key.ToLowerInvariant()
        let nextConditional = conditional || key = "if" || key = "else_if" || key = "else" || key = "random" || key = "random_list" || key = "limit"
        let nextPhase = if phaseOf node <> "" then phaseOf node else phase
        match stateOperation key with
        | Some operation ->
            accesses.Add
                { operation = operation
                  subject = subjectFromNode node
                  scope = stateScope key
                  line = int node.Position.StartLine
                  conditional = nextConditional
                  phase = nextPhase }
        | None -> ()
        for value in node.Values do
            match stateOperation value.Key with
            | Some operation ->
                accesses.Add
                    { operation = operation
                      subject = string value.Value |> fun raw -> raw.Trim().Trim('"')
                      scope = stateScope value.Key
                      line = int value.Position.StartLine
                      conditional = nextConditional
                      phase = nextPhase }
            | None -> ()
        for child in node.Nodes do visit child nextConditional nextPhase
    visit root false ""
    accesses |> Seq.distinctBy (fun item -> item.operation, item.subject, item.line) |> Seq.sortBy _.line |> Seq.toList

let private collectEventCalls definitionId file (root: Node) =
    let calls = ResizeArray<EventCall>()
    let rec visit (node: Node) =
        let key = node.Key.ToLowerInvariant()
        if eventCallOperators.Contains key && key <> "fire_on_action" then
            let id =
                node.Values
                |> Seq.tryFind (fun value -> value.Key.Equals("id", StringComparison.OrdinalIgnoreCase))
                |> Option.orElseWith (fun () -> node.Values |> Seq.tryHead)
                |> Option.map (fun value -> string value.Value |> fun raw -> raw.Trim().Trim('"'))
            let delayed =
                node.Values
                |> Seq.exists (fun value ->
                    let valueKey = value.Key.ToLowerInvariant()
                    valueKey = "days" || valueKey = "months" || valueKey = "years")
            id
            |> Option.filter (String.IsNullOrWhiteSpace >> not)
            |> Option.iter (fun target ->
                calls.Add
                    { sourceId = definitionId
                      targetId = target
                      operator = key
                      file = file
                      line = int node.Position.StartLine
                      delayed = delayed })
        for child in node.Nodes do visit child
    visit root
    calls |> Seq.toList

let stateIssues definitionId file (root: Node) =
    let issues = ResizeArray<FlowIssueFact>()
    let accesses = collectStateAccesses root
    let initialized = HashSet<string>(StringComparer.OrdinalIgnoreCase)
    let conditionalInitializers = HashSet<string>(StringComparer.OrdinalIgnoreCase)
    let cleared = HashSet<string>(StringComparer.OrdinalIgnoreCase)
    for access in accesses do
        let subjectKey = access.scope + ":" + access.subject
        match access.operation with
        | "set"
        | "save"
        | "write" ->
            if access.conditional then conditionalInitializers.Add subjectKey |> ignore
            else initialized.Add subjectKey |> ignore
        | "clear" -> cleared.Add subjectKey |> ignore
        | "read" when not (initialized.Contains subjectKey) ->
            let branchOnly = conditionalInitializers.Contains subjectKey
            issues.Add
                { kind = if branchOnly then "branch_incomplete_initialization" else "use_before_initialization"
                  severity = "warning"
                  definitionId = definitionId
                  subject = access.subject
                  message =
                    if branchOnly then "State is initialized only on a conditional branch before this read."
                    else "State is read before a visible initialization in this definition."
                  file = file
                  line = access.line
                  confidence = "heuristic"
                  provenance = "ordered-ast-state-analysis" }
        | _ -> ()
    for access in accesses do
        let subjectKey = access.scope + ":" + access.subject
        if (access.operation = "save" || (access.operation = "set" && access.scope <> "current_scope"))
           && not (cleared.Contains subjectKey) then
            issues.Add
                { kind = "lifecycle_imbalance"
                  severity = "info"
                  definitionId = definitionId
                  subject = access.subject
                  message = "Persistent or saved state has no visible clear/remove operation in this definition."
                  file = file
                  line = access.line
                  confidence = "heuristic"
                  provenance = "ordered-ast-state-analysis" }
    let calls = collectEventCalls definitionId file root
    let localTargets = accesses |> List.filter (fun item -> item.operation = "save" && item.scope = "local_event")
    for call in calls |> List.filter _.delayed do
        for target in localTargets |> List.filter (fun target -> target.line <= call.line) do
            issues.Add
                { kind = "delayed_local_event_target_risk"
                  severity = "warning"
                  definitionId = definitionId
                  subject = target.subject
                  message = "A local event target is saved before a delayed event call; local targets may not survive the delay boundary."
                  file = file
                  line = call.line
                  confidence = "heuristic"
                  provenance = "event-delay-state-analysis" }
    let rec createdScopeReads (node: Node) =
        seq {
            for value in node.Values do
                let raw = (value.Key + "=" + string value.Value).ToLowerInvariant()
                if raw.Contains "last_created_" then yield int value.Position.StartLine, raw
            if node.Key.ToLowerInvariant().Contains "last_created_" then yield int node.Position.StartLine, node.Key
            for child in node.Nodes do yield! createdScopeReads child
        }
    for line, subject in createdScopeReads root |> Seq.distinct do
        issues.Add
            { kind = "implicit_created_scope_dependency"
              severity = "info"
              definitionId = definitionId
              subject = subject
              message = "This effect depends on last_created_* implicit state; keep creation and consumption in the same deterministic flow."
              file = file
              line = line
              confidence = "semantic"
              provenance = "explicit-operator" }
    issues |> Seq.distinctBy (fun item -> item.kind, item.subject, item.line) |> Seq.toList

let private rootsByFile (game: IGame<'T>) =
    let map = Dictionary<string, ResizeArray<Node>>(StringComparer.OrdinalIgnoreCase)
    for struct (entity, _) in game.AllEntities() do
        let file = normalizePath entity.filepath
        let roots =
            match map.TryGetValue file with
            | true, values -> values
            | false, _ ->
                let values = ResizeArray<Node>()
                map.[file] <- values
                values
        roots.Add entity.rawEntity
    map

let analyzePdxFlowCancellable (shouldCancel: unit -> bool) (game: IGame<'T>) (query: FlowQuery) =
    let checkCancelled () = if shouldCancel () then raise (OperationCanceledException("PDX flow analysis was cancelled."))
    checkCancelled ()
    let byFile = rootsByFile game
    let costs = ResizeArray<CostFact>()
    let relations = ResizeArray<GameplayRelationFact>()
    let issues = ResizeArray<FlowIssueFact>()
    let eventCalls = ResizeArray<EventCall>()
    let eventDefinitions = Dictionary<string, string * string * int * bool>(StringComparer.OrdinalIgnoreCase)
    let visitedFiles = HashSet<string>(StringComparer.OrdinalIgnoreCase)
    let mutable definitionsConsidered = 0

    let considerFile (file: string) =
        checkCancelled ()
        if visitedFiles.Add file then
            match byFile.TryGetValue file with
            | true, roots ->
                for root in roots do
                    costs.AddRange(collectCosts root file)
            | false, _ -> ()

    match query.file with
    | Some requested when not (String.IsNullOrWhiteSpace requested) ->
        let normalized = requested.Replace('\\', '/')
        for file in byFile.Keys do
            if file.EndsWith(normalized, StringComparison.OrdinalIgnoreCase)
               || file.Contains(normalized, StringComparison.OrdinalIgnoreCase) then
                considerFile file
    | _ -> ()

    let rec descendantNodes (node: Node) =
        seq { yield node; for child in node.Nodes do yield! descendantNodes child }
    let findBlock (file: string) (range: CWTools.Utilities.Position.range) =
        match byFile.TryGetValue(normalizePath file) with
        | true, roots ->
            roots
            |> Seq.collect descendantNodes
            |> Seq.tryFind (fun node ->
                int node.Position.StartLine = int range.StartLine
                && int node.Position.EndLine = int range.EndLine)
        | _ -> None
    let definitions =
        game.Types()
        |> Map.toSeq
        |> Seq.collect (fun (definitionType, values) -> values |> Seq.map (fun value -> definitionType, value))
        |> Seq.filter (fun (definitionType, definition) ->
            query.entityType |> Option.forall (fun expected -> definitionType.Equals(expected, StringComparison.OrdinalIgnoreCase))
            && query.definitionId |> Option.forall (fun expected -> definition.id.Equals(expected, StringComparison.OrdinalIgnoreCase))
            && query.file |> Option.forall (fun expected -> normalizePath definition.range.FileName |> fun file -> file.EndsWith(normalizePath expected, StringComparison.OrdinalIgnoreCase)))
        |> Seq.sortBy (fun (definitionType, definition) -> definitionType, definition.id, normalizePath definition.range.FileName, int definition.range.StartLine)
        |> Seq.toList
    let knownScriptedDefinitions =
        game.Types()
        |> Map.toSeq
        |> Seq.collect (fun (definitionType, values) ->
            let lower = definitionType.ToLowerInvariant()
            if lower.Contains "scripted_effect" || lower.Contains "scripted_trigger" then
                values |> Seq.map (fun definition -> definition.id.ToLowerInvariant(), (definition.id, definitionType))
            else Seq.empty)
        |> dict
    let collectScriptedCalls (definitionId: string) (definitionType: string) file (root: Node) =
        let found = ResizeArray<GameplayRelationFact>()
        let add (key: string) line =
            match knownScriptedDefinitions.TryGetValue(key.ToLowerInvariant()) with
            | true, (targetId, targetType) when not (targetId.Equals(definitionId, StringComparison.OrdinalIgnoreCase)) ->
                found.Add
                    { relationType = if targetType.ToLowerInvariant().Contains "trigger" then "calls_scripted_trigger" else "calls_scripted_effect"
                      sourceId = definitionId
                      targetId = targetId
                      sourceType = definitionType
                      targetType = targetType
                      file = file
                      line = line
                      confidence = "semantic"
                      provenance = "exact-scripted-definition-id" }
            | _ -> ()
        let rec visit (node: Node) =
            add node.Key (int node.Position.StartLine)
            for value in node.Values do add value.Key (int value.Position.StartLine)
            for child in node.Nodes do visit child
        visit root
        found
    for definitionType, definition in definitions do
        checkCancelled ()
        definitionsConsidered <- definitionsConsidered + 1
        considerFile (normalizePath definition.range.FileName)
        match findBlock definition.range.FileName definition.range with
        | Some block ->
            relations.AddRange(collectRelations block (normalizePath definition.range.FileName) definition.id definitionType)
            relations.AddRange(collectScriptedCalls definition.id definitionType (normalizePath definition.range.FileName) block)
            issues.AddRange(stateIssues definition.id (normalizePath definition.range.FileName) block)
            eventCalls.AddRange(collectEventCalls definition.id (normalizePath definition.range.FileName) block)
            if definitionType.ToLowerInvariant().Contains "event" || block.Key.ToLowerInvariant().EndsWith("_event") then
                let isTriggeredOnly =
                    block.Values
                    |> Seq.exists (fun value ->
                        value.Key.Equals("is_triggered_only", StringComparison.OrdinalIgnoreCase)
                        && String.Equals(string value.Value, "yes", StringComparison.OrdinalIgnoreCase))
                eventDefinitions.[definition.id] <- block.Key.ToLowerInvariant(), normalizePath definition.range.FileName, int block.Position.StartLine, isTriggeredOnly
        | None -> ()

    for cost in costs do
        checkCancelled ()
        if cost.amplification = "potential_unbounded_loop" then
            issues.Add
                { kind = "potential_unbounded_loop"
                  severity = "warning"
                  definitionId = query.definitionId |> Option.defaultValue "<file>"
                  subject = cost.name
                  message = "while loop has no visible bound or progress operation."
                  file = cost.file
                  line = cost.line
                  confidence = "heuristic"
                  provenance = "static-cost-model" }

    let adjacency = Dictionary<string, ResizeArray<string>>(StringComparer.OrdinalIgnoreCase)
    let incoming = HashSet<string>(StringComparer.OrdinalIgnoreCase)
    for call in eventCalls do
        checkCancelled ()
        let targets =
            match adjacency.TryGetValue call.sourceId with
            | true, values -> values
            | _ -> let values = ResizeArray<string>() in adjacency.[call.sourceId] <- values; values
        targets.Add call.targetId
        incoming.Add call.targetId |> ignore
        match eventDefinitions.TryGetValue call.targetId with
        | true, (targetKind, _, _, _) ->
            let expectedKind =
                if call.operator.StartsWith("any_", StringComparison.Ordinal) then call.operator.Substring(4)
                else call.operator
            if expectedKind.EndsWith("_event", StringComparison.Ordinal)
               && targetKind.EndsWith("_event", StringComparison.Ordinal)
               && expectedKind <> targetKind then
                issues.Add
                    { kind = "event_scope_type_mismatch"
                      severity = "warning"
                      definitionId = call.sourceId
                      subject = call.targetId
                      message = sprintf "Call operator '%s' targets a '%s' definition." call.operator targetKind
                      file = call.file
                      line = call.line
                      confidence = "semantic"
                      provenance = "event-operator-and-target-definition" }
        | _ -> ()
        if call.delayed && call.sourceId.Equals(call.targetId, StringComparison.OrdinalIgnoreCase) then
            issues.Add
                { kind = "delayed_self_loop"
                  severity = "warning"
                  definitionId = call.sourceId
                  subject = call.targetId
                  message = "Event schedules itself with a delay; verify termination and cadence."
                  file = call.file
                  line = call.line
                  confidence = "semantic"
                  provenance = "event-call-graph" }
    let reaches start target =
        let visited = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        let rec walk current depth =
            if depth > 100 || not (visited.Add current) then false
            elif current.Equals(target, StringComparison.OrdinalIgnoreCase) then true
            else
                match adjacency.TryGetValue current with
                | true, values -> values |> Seq.exists (fun next -> walk next (depth + 1))
                | _ -> false
        walk start 0
    for call in eventCalls do
        checkCancelled ()
        if not (call.sourceId.Equals(call.targetId, StringComparison.OrdinalIgnoreCase)) && reaches call.targetId call.sourceId then
            issues.Add
                { kind = "event_cycle"
                  severity = "info"
                  definitionId = call.sourceId
                  subject = call.targetId
                  message = "Event call participates in a boundedly detected cycle."
                  file = call.file
                  line = call.line
                  confidence = "semantic"
                  provenance = "event-call-graph" }
    for KeyValue(eventId, (_, file, line, triggeredOnly)) in eventDefinitions do
        if triggeredOnly && not (incoming.Contains eventId) then
            issues.Add
                { kind = "possibly_unreachable_event"
                  severity = "info"
                  definitionId = eventId
                  subject = eventId
                  message = "Triggered-only event has no incoming event edge in the analyzed model; verify on_action or dynamic callers."
                  file = file
                  line = line
                  confidence = "heuristic"
                  provenance = "event-call-graph" }

    let limit = max 1 (min query.limit 500)
    let allCosts = costs |> Seq.distinctBy (fun item -> item.name, item.file, item.line) |> Seq.toList
    let allRelations = relations |> Seq.distinctBy (fun item -> item.relationType, item.sourceId, item.targetId, item.line) |> Seq.toList
    let allIssues = issues |> Seq.distinctBy (fun item -> item.kind, item.definitionId, item.subject, item.line) |> Seq.toList
    checkCancelled ()
    { costs = allCosts |> List.truncate limit
      relations = allRelations |> List.truncate limit
      issues = allIssues |> List.truncate limit
      filesConsidered = visitedFiles.Count
      definitionsConsidered = definitionsConsidered
      truncated = allCosts.Length > limit || allRelations.Length > limit || allIssues.Length > limit }

let analyzePdxFlow game query = analyzePdxFlowCancellable (fun () -> false) game query

let flowAnalysisJsonWithFreshness (facts: FlowAnalysisFacts) freshness staleReasons =
    let costJson (cost: CostFact) =
        jsonRecord
            [ Some("kind", JsonValue.String cost.kind)
              Some("name", JsonValue.String cost.name)
              Some("scope", JsonValue.String cost.scope)
              Some("phase", JsonValue.String cost.phase)
              Some("nestingDepth", JsonValue.Number(decimal cost.nestingDepth))
              Some("frequency", JsonValue.String cost.frequency)
              Some("traversalRange", JsonValue.String cost.traversalRange)
              Some("amplification", JsonValue.String cost.amplification)
              Some("file", JsonValue.String cost.file)
              Some("line", JsonValue.Number(decimal cost.line))
              Some("confidence", JsonValue.String cost.confidence) ]
    let relationJson (relation: GameplayRelationFact) =
        jsonRecord
            [ Some("relationType", JsonValue.String relation.relationType)
              Some("sourceId", JsonValue.String relation.sourceId)
              Some("targetId", JsonValue.String relation.targetId)
              Some("sourceType", JsonValue.String relation.sourceType)
              Some("targetType", JsonValue.String relation.targetType)
              Some("file", JsonValue.String relation.file)
              Some("line", JsonValue.Number(decimal relation.line))
              Some("confidence", JsonValue.String relation.confidence)
              Some("provenance", JsonValue.String relation.provenance) ]
    let issueJson (issue: FlowIssueFact) =
        jsonRecord
            [ Some("kind", JsonValue.String issue.kind)
              Some("severity", JsonValue.String issue.severity)
              Some("definitionId", JsonValue.String issue.definitionId)
              Some("subject", JsonValue.String issue.subject)
              Some("message", JsonValue.String issue.message)
              Some("file", JsonValue.String issue.file)
              Some("line", JsonValue.Number(decimal issue.line))
              Some("confidence", JsonValue.String issue.confidence)
              Some("provenance", JsonValue.String issue.provenance) ]
    jsonRecord
        [ Some("ok", JsonValue.Boolean true)
          Some("source", JsonValue.String "cwtools-pdx-flow-analysis")
          Some("version", JsonValue.Number 2m)
          Some("freshness", jsonRecord
              [ Some("status", JsonValue.String freshness)
                Some("source", JsonValue.String "active_lsp_model")
                Some("staleReasons", jsonStringArray staleReasons) ])
          Some("costModel", jsonRecord
              [ Some("relativeWeights", jsonRecord
                  [ Some("galaxy", JsonValue.Number 100m)
                    Some("country", JsonValue.Number 30m)
                    Some("whilePotentiallyUnbounded", JsonValue.Number 60m)
                    Some("nested", JsonValue.Number 40m) ])
                Some("caveat", JsonValue.String "Relative static weights, not predicted runtime. while loops are only marked potentially unbounded when no visible bound/progress operation is found; verify high-cost paths in-game.") ])
          Some("costs", facts.costs
              |> List.sortByDescending (fun item -> item.nestingDepth)
              |> List.map costJson |> List.toArray |> JsonValue.Array)
          Some("relations", facts.relations
              |> List.sortBy (fun item -> item.relationType, item.sourceId)
              |> List.map relationJson |> List.toArray |> JsonValue.Array)
          Some("issues", facts.issues
              |> List.sortBy (fun item -> item.severity, item.kind, item.definitionId, item.line)
              |> List.map issueJson |> List.toArray |> JsonValue.Array)
          Some("coverage", jsonRecord
              [ Some("filesConsidered", JsonValue.Number(decimal facts.filesConsidered))
                Some("filesIndexed", JsonValue.Number(decimal facts.filesConsidered))
                Some("definitionsConsidered", JsonValue.Number(decimal facts.definitionsConsidered))
                Some("definitionsIndexed", JsonValue.Number(decimal facts.definitionsConsidered))
                Some("costsFound", JsonValue.Number(decimal facts.costs.Length))
                Some("relationsFound", JsonValue.Number(decimal facts.relations.Length))
                Some("issuesFound", JsonValue.Number(decimal facts.issues.Length))
                Some("truncated", JsonValue.Boolean facts.truncated)
                Some("staleReasons", jsonStringArray staleReasons)
                Some("unsupportedConstructs", jsonStringArray [ "runtime_costs_require_profiling"; "dynamic_scope_dispatch_may_require_runtime_evidence" ]) ]) ]

let flowAnalysisJson facts = flowAnalysisJsonWithFreshness facts "fresh" []
