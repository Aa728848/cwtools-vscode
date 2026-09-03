module Main.PdxFlowAnalysis

open System
open System.Collections.Generic
open System.Text.RegularExpressions
open FSharp.Data
open CWTools.Games
open CWTools.Process
open Main.SemanticGraph

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

type PropagatedCostFact =
    { sourceId: string
      targetId: string
      callPath: string list
      effectiveFrequency: string
      relativeScore: int
      localCostCount: int
      provenance: string }

type FlowAnalysisFacts =
    { costs: CostFact list
      propagatedCosts: PropagatedCostFact list
      relations: GameplayRelationFact list
      issues: FlowIssueFact list
      filesConsidered: int
      definitionsConsidered: int
      inlineExpansionsConsidered: int
      truncated: bool }

type FlowQuery =
    { file: string option
      definitionId: string option
      entityType: string option
      limit: int }

let private normalizePath (value: string) =
    value.Replace('\\', '/').Trim().TrimStart('/').ToLowerInvariant()


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

let propagateCosts (seedIds: string list) (definitionCosts: (string * CostFact list) list) (relations: GameplayRelationFact list) =
    let costsByDefinition = Dictionary<string, CostFact list>(StringComparer.OrdinalIgnoreCase)
    for definitionId, costs in definitionCosts do costsByDefinition.[definitionId] <- costs
    let callGraph = Dictionary<string, ResizeArray<string>>(StringComparer.OrdinalIgnoreCase)
    for relation in relations do
        if relation.relationType = "calls_event"
           || relation.relationType = "calls_scripted_effect"
           || relation.relationType = "calls_scripted_trigger"
           || relation.relationType = "fires_on_action" then
            let targets =
                match callGraph.TryGetValue relation.sourceId with
                | true, values -> values
                | _ -> let values = ResizeArray<string>() in callGraph.[relation.sourceId] <- values; values
            if not (targets.Contains relation.targetId) then targets.Add relation.targetId
    let frequencyRank value =
        match value with
        | "daily" -> 365
        | "monthly" -> 12
        | "quarterly" -> 4
        | "yearly" -> 1
        | "per_tick_while_running" -> 500
        | _ -> 1
    let relativeCostScore (items: CostFact list) =
        items
        |> List.sumBy (fun cost ->
            let scopeWeight = if traversalWeight.ContainsKey cost.scope then traversalWeight.[cost.scope] else 10
            scopeWeight * max 1 (cost.nestingDepth + 1))
    let propagated = ResizeArray<PropagatedCostFact>()
    for seedId in seedIds do
        let inheritedFrequency =
            match costsByDefinition.TryGetValue seedId with
            | true, seedCosts ->
                seedCosts
                |> List.sortByDescending (fun cost -> frequencyRank cost.frequency)
                |> List.tryHead
                |> Option.map _.frequency
                |> Option.defaultValue "event_or_effect"
            | _ -> "event_or_effect"
        let queue = Queue<string * string list * int>()
        let visited = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        queue.Enqueue(seedId, [ seedId ], 0)
        while queue.Count > 0 do
            let current, path, depth = queue.Dequeue()
            if depth <= 8 && visited.Add current then
                match callGraph.TryGetValue current with
                | true, targets ->
                    for target in targets |> Seq.sort do
                        let nextPath = path @ [ target ]
                        match costsByDefinition.TryGetValue target with
                        | true, targetCosts when not targetCosts.IsEmpty ->
                            propagated.Add
                                { sourceId = seedId
                                  targetId = target
                                  callPath = nextPath
                                  effectiveFrequency = inheritedFrequency
                                  relativeScore = relativeCostScore targetCosts * frequencyRank inheritedFrequency
                                  localCostCount = targetCosts.Length
                                  provenance = "bounded-static-call-graph" }
                        | _ -> ()
                        if depth < 8 then queue.Enqueue(target, nextPath, depth + 1)
                | _ -> ()
    propagated
    |> Seq.distinctBy (fun item -> item.sourceId, item.targetId, item.callPath)
    |> Seq.sortByDescending _.relativeScore
    |> Seq.toList

/// Collect gameplay relations from a definition root.
let private collectRelationsWithOperators (eventCallOperators: Set<string>) (root: Node) (file: string) (definitionId: string) (definitionType: string) =
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

let collectRelations (root: Node) (file: string) (definitionId: string) (definitionType: string) =
    collectRelationsWithOperators (PdxEventSemantics.eventCallOperatorsInNode root) root file definitionId definitionType

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
      targetKind: string
      operator: string
      file: string
      line: int
      delayed: bool
      delay: string option
      phase: string
      conditionPath: string option
      scopeMap: string option
      sourceScope: string option
      targetScope: string option }

let private stateOperation (key: string) =
    let lower = key.ToLowerInvariant()
    if lower.StartsWith("event_target:") || lower.StartsWith("global_event_target:") then Some "read"
    elif lower.StartsWith("save_") && lower.Contains("event_target") then Some "save"
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

let private stateSubjectFromKeyOrNode (key: string) (node: Node) =
    let separator = key.IndexOf(':')
    if separator >= 0 && separator + 1 < key.Length then key.Substring(separator + 1)
    else subjectFromNode node

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
                  subject = stateSubjectFromKeyOrNode node.Key node
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
            let rawValue = string value.Value
            for found in Regex.Matches(rawValue, @"(?:global_)?event_target:([A-Za-z_][A-Za-z0-9_.-]*)", RegexOptions.IgnoreCase) do
                accesses.Add
                    { operation = "read"
                      subject = found.Groups.[1].Value
                      scope = if found.Value.StartsWith("global_", StringComparison.OrdinalIgnoreCase) then "global" else "local_event"
                      line = int value.Position.StartLine
                      conditional = nextConditional
                      phase = nextPhase }
        for child in node.Nodes do visit child nextConditional nextPhase
    visit root false ""
    accesses |> Seq.distinctBy (fun item -> item.operation, item.subject, item.line) |> Seq.sortBy _.line |> Seq.toList

let private eventScopeFromKey (key: string) =
    let lower = key.ToLowerInvariant()
    if lower.EndsWith("_event", StringComparison.Ordinal) then Some(lower.Substring(0, lower.Length - 6))
    else None

let private conditionPathText path =
    match path |> List.rev with
    | [] -> None
    | ordered ->
        let relation =
            if ordered |> List.exists (fun value -> value = "not" || value = "nor" || value = "else") then "blocks"
            elif ordered |> List.exists (fun value -> value = "or" || value = "random_list" || value = "switch" || value = "else_if") then "alternative"
            else "requires"
        Some(relation + ":" + String.concat ">" ordered)

let private collectEventCalls (eventCallOperators: Set<string>) definitionId file (root: Node) =
    let calls = ResizeArray<EventCall>()
    let sourceScope = eventScopeFromKey root.Key
    let rec visit (node: Node) phase conditionPath =
        let key = node.Key.ToLowerInvariant()
        let nextPhase = if phaseOf node <> "" then phaseOf node else phase
        let nextPath =
            if key = "if" || key = "else_if" || key = "else" || key = "and" || key = "or"
               || key = "nor" || key = "not" || key = "random_list" || key = "switch" || key = "while" then
                key :: conditionPath
            else conditionPath
        for value in node.Values do
            let valueKey = value.Key.ToLowerInvariant()
            if eventCallOperators.Contains valueKey then
                let target = (string value.Value).Trim().Trim('"')
                if not (String.IsNullOrWhiteSpace target) then
                    calls.Add
                        { sourceId = definitionId
                          targetId = target
                          targetKind = if valueKey = "fire_on_action" then "on_action" else "event"
                          operator = valueKey
                          file = file
                          line = int value.Position.StartLine
                          delayed = false
                          delay = None
                          phase = if String.IsNullOrWhiteSpace nextPhase then "effect" else nextPhase
                          conditionPath = conditionPathText nextPath
                          scopeMap = None
                          sourceScope = sourceScope
                          targetScope = if valueKey = "fire_on_action" then None else eventScopeFromKey valueKey }
        if eventCallOperators.Contains key then
            let id =
                node.Values
                |> Seq.tryFind (fun value ->
                    value.Key.Equals("id", StringComparison.OrdinalIgnoreCase)
                    || (key = "fire_on_action" && (value.Key.Equals("on_action", StringComparison.OrdinalIgnoreCase) || value.Key.Equals("name", StringComparison.OrdinalIgnoreCase))))
                |> Option.orElseWith (fun () -> node.Values |> Seq.tryHead)
                |> Option.map (fun value -> string value.Value |> fun raw -> raw.Trim().Trim('"'))
            let delayParts =
                node.Values
                |> Seq.choose (fun value ->
                    let valueKey = value.Key.ToLowerInvariant()
                    if valueKey = "days" || valueKey = "months" || valueKey = "years" || valueKey = "random" then
                        Some(valueKey + "=" + (string value.Value).Trim().Trim('"'))
                    else None)
                |> Seq.toList
            let scopeMap =
                node.Nodes
                |> Seq.tryFind (fun child -> child.Key.Equals("scopes", StringComparison.OrdinalIgnoreCase))
                |> Option.map (fun scopes ->
                    scopes.Leaves
                    |> Seq.map (fun leaf -> leaf.Key + "->" + string leaf.Value)
                    |> Seq.sort
                    |> String.concat ",")
                |> Option.filter (String.IsNullOrWhiteSpace >> not)
            id
            |> Option.filter (String.IsNullOrWhiteSpace >> not)
            |> Option.iter (fun target ->
                calls.Add
                    { sourceId = definitionId
                      targetId = target
                      targetKind = if key = "fire_on_action" then "on_action" else "event"
                      operator = key
                      file = file
                      line = int node.Position.StartLine
                      delayed = not delayParts.IsEmpty
                      delay = if delayParts.IsEmpty then None else Some(String.concat "," delayParts)
                      phase = if String.IsNullOrWhiteSpace nextPhase then "effect" else nextPhase
                      conditionPath = conditionPathText nextPath
                      scopeMap = scopeMap
                      sourceScope = sourceScope
                      targetScope = if key = "fire_on_action" then None else eventScopeFromKey key })
        for child in node.Nodes do visit child nextPhase nextPath
    visit root "" []
    calls |> Seq.toList

let private stateIssuesWithOperators eventCallOperators definitionId file (root: Node) =
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
    let calls = collectEventCalls eventCallOperators definitionId file root
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

let stateIssues definitionId file (root: Node) =
    stateIssuesWithOperators (PdxEventSemantics.eventCallOperatorsInNode root) definitionId file root

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
    let eventCallOperators = PdxEventSemantics.eventCallOperators game
    let costs = ResizeArray<CostFact>()
    let relations = ResizeArray<GameplayRelationFact>()
    let issues = ResizeArray<FlowIssueFact>()
    let eventCalls = ResizeArray<EventCall>()
    let stateAccessesByDefinition = Dictionary<string, StateAccess list>(StringComparer.OrdinalIgnoreCase)
    let localCostsByDefinition = Dictionary<string, CostFact list>(StringComparer.OrdinalIgnoreCase)
    let eventDefinitions = Dictionary<string, string * string * int * bool>(StringComparer.OrdinalIgnoreCase)
    let visitedFiles = HashSet<string>(StringComparer.OrdinalIgnoreCase)
    let mutable definitionsConsidered = 0
    let mutable inlineExpansionsConsidered = 0

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
    let allDefinitions =
        game.Types()
        |> Map.toSeq
        |> Seq.collect (fun (definitionType, values) -> values |> Seq.map (fun value -> definitionType, value))
        |> Seq.toList
    let inlineGraph = InlineGraph.collectInlineGraphCancellable shouldCancel (game.AllEntities())
    let seedDefinitions =
        allDefinitions
        |> Seq.ofList
        |> Seq.filter (fun (definitionType, definition) ->
            query.entityType |> Option.forall (fun expected -> definitionType.Equals(expected, StringComparison.OrdinalIgnoreCase))
            && query.definitionId |> Option.forall (fun expected -> definition.id.Equals(expected, StringComparison.OrdinalIgnoreCase))
            && query.file |> Option.forall (fun expected -> normalizePath definition.range.FileName |> fun file -> file.EndsWith(normalizePath expected, StringComparison.OrdinalIgnoreCase)))
        |> Seq.sortBy (fun (definitionType, definition) -> definitionType, definition.id, normalizePath definition.range.FileName, int definition.range.StartLine)
        |> Seq.toList
    let knownScriptedDefinitions = Dictionary<string, string * string>(StringComparer.OrdinalIgnoreCase)
    let definitionsById = Dictionary<string, ResizeArray<string * CWTools.Common.NewScope.TypeDefInfo>>(StringComparer.OrdinalIgnoreCase)
    for definitionType, definition in allDefinitions |> List.sortBy (fun (definitionType, definition) -> definitionType, definition.id) do
        let bucket =
            match definitionsById.TryGetValue definition.id with
            | true, values -> values
            | _ -> let values = ResizeArray() in definitionsById.[definition.id] <- values; values
        bucket.Add(definitionType, definition)
        let lower = definitionType.ToLowerInvariant()
        if (lower.Contains "scripted_effect" || lower.Contains "scripted_trigger")
           && not (knownScriptedDefinitions.ContainsKey definition.id) then
            knownScriptedDefinitions.[definition.id] <- definition.id, definitionType
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
    let invocationById = inlineGraph.invocations |> Seq.map (fun item -> item.invocationId, item) |> dict
    let inlineReferencesFor definitionId =
        inlineGraph.generatedReferences
        |> List.filter (fun reference ->
            match invocationById.TryGetValue reference.invocationId with
            | true, invocation -> invocation.enclosingDefinition |> Option.exists (fun value -> value.Equals(definitionId, StringComparison.OrdinalIgnoreCase))
            | _ -> false)
    let selectionLimit = max 1 (min query.limit 500)
    let selected = ResizeArray<string * CWTools.Common.NewScope.TypeDefInfo>()
    let selectedKeys = HashSet<string>(StringComparer.OrdinalIgnoreCase)
    let queuedKeys = HashSet<string>(StringComparer.OrdinalIgnoreCase)
    let queue = Queue<string * CWTools.Common.NewScope.TypeDefInfo>()
    let definitionKey (definitionType: string) (definition: CWTools.Common.NewScope.TypeDefInfo) =
        definitionType + "\u0000" + definition.id + "\u0000" + normalizePath definition.range.FileName + "\u0000" + string definition.range.StartLine
    let enqueue (definitionType, definition) =
        let key = definitionKey definitionType definition
        if queuedKeys.Add key then queue.Enqueue(definitionType, definition)
    for definition in seedDefinitions do enqueue definition
    let enqueueTarget targetId preferredKind =
        match definitionsById.TryGetValue targetId with
        | true, candidates ->
            let preferred =
                candidates
                |> Seq.filter (fun (definitionType, _) ->
                    match preferredKind with
                    | "event" -> definitionType.Contains("event", StringComparison.OrdinalIgnoreCase)
                    | "on_action" -> definitionType.Contains("on_action", StringComparison.OrdinalIgnoreCase)
                    | "scripted" -> definitionType.Contains("scripted_", StringComparison.OrdinalIgnoreCase)
                    | _ -> true)
                |> Seq.toList
            for candidate in (if preferred.IsEmpty then candidates |> Seq.toList else preferred) do enqueue candidate
        | _ -> ()
    while queue.Count > 0 && selected.Count < selectionLimit do
        checkCancelled ()
        let definitionType, definition = queue.Dequeue()
        let key = definitionKey definitionType definition
        if selectedKeys.Add key then
            selected.Add(definitionType, definition)
            match findBlock definition.range.FileName definition.range with
            | Some block ->
                for call in collectEventCalls eventCallOperators definition.id (normalizePath definition.range.FileName) block do
                    enqueueTarget call.targetId call.targetKind
                for relation in collectScriptedCalls definition.id definitionType (normalizePath definition.range.FileName) block do
                    enqueueTarget relation.targetId "scripted"
                for reference in inlineReferencesFor definition.id do
                    if reference.referenceKind = "event" then enqueueTarget reference.expandedValue "event"
                    elif reference.referenceKind = "call_candidate" && knownScriptedDefinitions.ContainsKey reference.expandedValue then
                        enqueueTarget reference.expandedValue "scripted"
            | None -> ()
    let definitions = selected |> Seq.toList
    for definitionType, definition in definitions do
        checkCancelled ()
        definitionsConsidered <- definitionsConsidered + 1
        considerFile (normalizePath definition.range.FileName)
        match findBlock definition.range.FileName definition.range with
        | Some block ->
            let definitionFile = normalizePath definition.range.FileName
            relations.AddRange(collectRelationsWithOperators eventCallOperators block definitionFile definition.id definitionType)
            relations.AddRange(collectScriptedCalls definition.id definitionType definitionFile block)
            issues.AddRange(stateIssuesWithOperators eventCallOperators definition.id definitionFile block)
            let inlineReferences = inlineReferencesFor definition.id
            let directCosts = collectCosts block definitionFile
            let expandedCosts = ResizeArray<CostFact>()
            let expandedState = ResizeArray<StateAccess>()
            let relevantInvocations =
                inlineGraph.invocations
                |> List.filter (fun invocation ->
                    invocation.enclosingDefinition
                    |> Option.exists (fun value -> value.Equals(definition.id, StringComparison.OrdinalIgnoreCase)))
            for invocation in relevantInvocations do
                inlineExpansionsConsidered <- inlineExpansionsConsidered + 1
                relations.Add
                    { relationType = "expands_inline_script"
                      sourceId = definition.id
                      targetId = invocation.templateId
                      sourceType = definitionType
                      targetType = "inline_script"
                      file = definitionFile
                      line = invocation.callerLine
                      confidence = "semantic"
                      provenance = "inline-instantiation-graph" }
                inlineGraph.templates
                |> List.tryFind (fun template -> template.templateId.Equals(invocation.templateId, StringComparison.OrdinalIgnoreCase))
                |> Option.iter (fun template ->
                    match byFile.TryGetValue(normalizePath template.file) with
                    | true, roots ->
                        for root in roots do expandedCosts.AddRange(collectCosts root (normalizePath template.file))
                    | _ -> ())
            for reference in inlineReferences do
                if reference.referenceKind.StartsWith("state:", StringComparison.Ordinal) then
                    match reference.referenceKind.Split(':') with
                    | [| _; operation; scope |] ->
                        expandedState.Add
                            { operation = operation
                              subject = reference.expandedValue
                              scope = scope
                              line = reference.generatedLine
                              conditional = false
                              phase = "inline_expansion" }
                    | _ -> ()
                elif reference.referenceKind = "event" then
                    eventCalls.Add
                        { sourceId = definition.id
                          targetId = reference.expandedValue
                          targetKind = "event"
                          operator = "inline_event_reference"
                          file = definitionFile
                          line = reference.generatedLine
                          delayed = false
                          delay = None
                          phase = "inline_expansion"
                          conditionPath = None
                          scopeMap = None
                          sourceScope = eventScopeFromKey block.Key
                          targetScope = None }
                elif reference.referenceKind = "call_candidate" then
                    match knownScriptedDefinitions.TryGetValue reference.expandedValue with
                    | true, (targetId, targetType) when not (targetId.Equals(definition.id, StringComparison.OrdinalIgnoreCase)) ->
                        relations.Add
                            { relationType = if targetType.ToLowerInvariant().Contains "trigger" then "calls_scripted_trigger" else "calls_scripted_effect"
                              sourceId = definition.id
                              targetId = targetId
                              sourceType = definitionType
                              targetType = targetType
                              file = definitionFile
                              line = reference.generatedLine
                              confidence = "semantic"
                              provenance = "inline-expanded-scripted-definition-id" }
                    | _ -> ()
            let combinedCosts = directCosts @ (expandedCosts |> Seq.toList)
            localCostsByDefinition.[definition.id] <- combinedCosts
            costs.AddRange expandedCosts
            stateAccessesByDefinition.[definition.id] <- collectStateAccesses block @ (expandedState |> Seq.toList)
            eventCalls.AddRange(collectEventCalls eventCallOperators definition.id definitionFile block)
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
    let incomingCalls = Dictionary<string, ResizeArray<EventCall>>(StringComparer.OrdinalIgnoreCase)
    for call in eventCalls do
        checkCancelled ()
        if call.targetKind = "on_action" then
            relations.Add
                { relationType = "fires_on_action"
                  sourceId = call.sourceId
                  targetId = call.targetId
                  sourceType = "event_or_definition"
                  targetType = "on_action"
                  file = call.file
                  line = call.line
                  confidence = "semantic"
                  provenance = "explicit-fire_on_action" }
        else
            relations.Add
                { relationType = "calls_event"
                  sourceId = call.sourceId
                  targetId = call.targetId
                  sourceType = "event_or_definition"
                  targetType = "event"
                  file = call.file
                  line = call.line
                  confidence = "semantic"
                  provenance = if call.operator = "inline_event_reference" then "inline-instantiation-graph" else "explicit-event-call" }
            let incomingForTarget =
                match incomingCalls.TryGetValue call.targetId with
                | true, values -> values
                | _ -> let values = ResizeArray<EventCall>() in incomingCalls.[call.targetId] <- values; values
            incomingForTarget.Add call
        let targets =
            match adjacency.TryGetValue call.sourceId with
            | true, values -> values
            | _ -> let values = ResizeArray<string>() in adjacency.[call.sourceId] <- values; values
        if call.targetKind = "event" then
            targets.Add call.targetId
            incoming.Add call.targetId |> ignore
        let targetDefinition =
            if call.targetKind <> "event" then None
            else
                match eventDefinitions.TryGetValue call.targetId with
                | true, value -> Some value
                | _ -> None
        match targetDefinition with
        | Some(targetKind, _, _, _) ->
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
        | None -> ()
        match call.sourceScope, call.targetScope with
        | Some sourceScope, Some targetScope when sourceScope <> targetScope && call.scopeMap.IsNone ->
            issues.Add
                { kind = "scope_bridge_unproven"
                  severity = "info"
                  definitionId = call.sourceId
                  subject = call.targetId
                  message = sprintf "Call operator '%s' bridges %s to %s without an explicit scopes map; verify ROOT/FROM/PREV semantics." call.operator sourceScope targetScope
                  file = call.file
                  line = call.line
                  confidence = "heuristic"
                  provenance = "event-call-scope-map" }
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
    // Cross-event state propagation. A directed edge is emitted when a caller
    // visibly initializes state before the call and the callee reads the same
    // scoped subject. Reads with known callers but no visible incoming write
    // remain warnings rather than definite errors because runtime entry points
    // may initialize state outside the analyzed slice.
    for KeyValue(targetId, callers) in incomingCalls do
        match stateAccessesByDefinition.TryGetValue targetId with
        | true, targetAccesses ->
            let targetReads = targetAccesses |> List.filter (fun access -> access.operation = "read")
            for read in targetReads do
                let matchingWriters =
                    callers
                    |> Seq.choose (fun call ->
                        match stateAccessesByDefinition.TryGetValue call.sourceId with
                        | true, sourceAccesses ->
                            sourceAccesses
                            |> List.tryFind (fun access ->
                                access.line <= call.line
                                && (access.operation = "set" || access.operation = "save" || access.operation = "write")
                                && access.scope.Equals(read.scope, StringComparison.OrdinalIgnoreCase)
                                && access.subject.Equals(read.subject, StringComparison.OrdinalIgnoreCase))
                            |> Option.map (fun _ -> call)
                        | _ -> None)
                    |> Seq.toList
                for writer in matchingWriters do
                    relations.Add
                        { relationType = "state_flows_to_event:" + read.scope + ":" + read.subject
                          sourceId = writer.sourceId
                          targetId = targetId
                          sourceType = "event"
                          targetType = "event"
                          file = writer.file
                          line = writer.line
                          confidence = "derived"
                          provenance = "ordered-state-write-before-event-call" }
                if matchingWriters.IsEmpty && callers.Count > 0 then
                    issues.Add
                        { kind = "interprocedural_use_before_initialization"
                          severity = "info"
                          definitionId = targetId
                          subject = read.subject
                          message = "Known incoming event callers do not visibly initialize this scoped state before the call; verify external or runtime initialization."
                          file = callers.[0].file
                          line = read.line
                          confidence = "heuristic"
                          provenance = "bounded-incoming-event-state-analysis" }
        | _ -> ()

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
    let targetExists (relation: GameplayRelationFact) =
        allDefinitions
        |> List.exists (fun (definitionType, definition) ->
            definition.id.Equals(relation.targetId, StringComparison.OrdinalIgnoreCase)
            && (definitionType.Equals(relation.targetType, StringComparison.OrdinalIgnoreCase)
                || definitionType.Contains(relation.targetType, StringComparison.OrdinalIgnoreCase)
                || relation.targetType.Contains(definitionType, StringComparison.OrdinalIgnoreCase)))
    let allRelations =
        relations
        |> Seq.distinctBy (fun item -> item.relationType, item.sourceId, item.targetId, item.line)
        |> Seq.map (fun item ->
            if targetExists item then
                { item with confidence = "semantic"; provenance = "resolved-definition-id" }
            else item)
        |> Seq.toList
    let propagatedCosts =
        propagateCosts
            (seedDefinitions |> List.map (fun (_, definition) -> definition.id))
            (localCostsByDefinition |> Seq.map (fun pair -> pair.Key, pair.Value) |> Seq.toList)
            allRelations
    for relation in allRelations do
        if relation.confidence <> "semantic"
           && not (relation.targetId.Contains("$", StringComparison.Ordinal))
           && not (relation.targetId.StartsWith("event_target:", StringComparison.OrdinalIgnoreCase)) then
            issues.Add
                { kind = "unresolved_gameplay_target"
                  severity = "info"
                  definitionId = relation.sourceId
                  subject = relation.targetId
                  message = sprintf "The typed target '%s' (%s) was not resolved in the active semantic catalog." relation.targetId relation.targetType
                  file = relation.file
                  line = relation.line
                  confidence = "heuristic"
                  provenance = "typed-relation-resolution" }
    let allIssues = issues |> Seq.distinctBy (fun item -> item.kind, item.definitionId, item.subject, item.line) |> Seq.toList
    checkCancelled ()
    { costs = allCosts |> List.truncate limit
      propagatedCosts = propagatedCosts |> List.truncate limit
      relations = allRelations |> List.truncate limit
      issues = allIssues |> List.truncate limit
      filesConsidered = visitedFiles.Count
      definitionsConsidered = definitionsConsidered
      inlineExpansionsConsidered = inlineExpansionsConsidered
      truncated = allCosts.Length > limit || allRelations.Length > limit || allIssues.Length > limit || propagatedCosts.Length > limit }

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
    let propagatedCostJson (cost: PropagatedCostFact) =
        jsonRecord
            [ Some("sourceId", JsonValue.String cost.sourceId)
              Some("targetId", JsonValue.String cost.targetId)
              Some("callPath", jsonStringArray cost.callPath)
              Some("effectiveFrequency", JsonValue.String cost.effectiveFrequency)
              Some("relativeScore", JsonValue.Number(decimal cost.relativeScore))
              Some("localCostCount", JsonValue.Number(decimal cost.localCostCount))
              Some("provenance", JsonValue.String cost.provenance) ]
    jsonRecord
        [ Some("ok", JsonValue.Boolean true)
          Some("source", JsonValue.String "cwtools-pdx-flow-analysis")
          Some("version", JsonValue.Number 4m)
          Some("freshness", activeModelFreshnessRecord freshness staleReasons)
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
          Some("propagatedCosts", facts.propagatedCosts
              |> List.sortByDescending _.relativeScore
              |> List.map propagatedCostJson |> List.toArray |> JsonValue.Array)
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
                Some("inlineExpansionsConsidered", JsonValue.Number(decimal facts.inlineExpansionsConsidered))
                Some("costsFound", JsonValue.Number(decimal facts.costs.Length))
                Some("propagatedCostsFound", JsonValue.Number(decimal facts.propagatedCosts.Length))
                Some("relationsFound", JsonValue.Number(decimal facts.relations.Length))
                Some("issuesFound", JsonValue.Number(decimal facts.issues.Length))
                Some("truncated", JsonValue.Boolean facts.truncated)
                Some("staleReasons", jsonStringArray staleReasons)
                Some("unsupportedConstructs", jsonStringArray [ "runtime_costs_require_profiling"; "dynamic_scope_dispatch_may_require_runtime_evidence"; "external_runtime_entrypoints_can_initialize_state" ]) ]) ]

let flowAnalysisJson facts = flowAnalysisJsonWithFreshness facts "fresh" []
