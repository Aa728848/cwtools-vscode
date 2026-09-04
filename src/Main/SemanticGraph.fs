module Main.SemanticGraph

open System
open System.Collections.Generic
open System.Text.RegularExpressions
open FSharp.Data
open CWTools.Games
open CWTools.Utilities.Position
open CWTools.Utilities.StringResource

/// A bounded semantic-graph query over the already-loaded CWTools game model.
/// The graph deliberately reuses CWTools' typed definitions and ComputedData so
/// CWT scope/type semantics remain the only source of truth.
type ExploreOptions =
    { query: string
      file: string option
      typeName: string option
      exact: bool
      depth: int
      maxNodes: int
      maxEdges: int
      includeMetadata: bool }

type RuntimeMetadata =
    { graphVersion: int64
      status: string
      validationInProgress: bool
      loadingInProgress: bool
      pendingGlobalKinds: string list
      lastGlobalRefreshAtUnixMs: int64 }

type OverrideResolution<'T> =
    { winner: 'T option
      resolution: string
      ambiguous: bool
      ambiguousReason: string option }

module OverrideResolver =
    let resolveWinner
        (strategy: string option)
        (isSingleCwtoolsActive: bool)
        (activeWinner: 'T option)
        (orderedCandidates: 'T list) : OverrideResolution<'T> =
        if isSingleCwtoolsActive && activeWinner.IsSome then
            { winner = activeWinner
              resolution = "cwtools_single_active"
              ambiguous = false
              ambiguousReason = None }
        else
            match strategy with
            | Some "LIOS" ->
                { winner = orderedCandidates |> List.tryLast
                  resolution = "last_in_only_served"
                  ambiguous = false
                  ambiguousReason = None }
            | Some "FIOS" ->
                { winner = orderedCandidates |> List.tryHead
                  resolution = "first_in_only_served"
                  ambiguous = false
                  ambiguousReason = None }
            | Some "NO" ->
                { winner = orderedCandidates |> List.tryHead
                  resolution = "no_individual_override"
                  ambiguous = false
                  ambiguousReason = Some "NO does not permit an individual same-key override; the earliest existing candidate remains effective unless the owning file is replaced." }
            | Some "MERGE" ->
                { winner = None
                  resolution = "merged_definitions"
                  ambiguous = false
                  ambiguousReason = Some "MERGE combines candidates; no single definition wins." }
            | Some "DUPL" ->
                { winner = None
                  resolution = "duplicate_definitions"
                  ambiguous = false
                  ambiguousReason = Some "DUPL preserves multiple candidates; no single definition wins." }
            | Some mode ->
                { winner = None
                  resolution = "ambiguous"
                  ambiguous = true
                  ambiguousReason = Some(sprintf "Override mode %s has no deterministic resolver." mode) }
            | None ->
                if orderedCandidates.Length = 1 then
                    { winner = orderedCandidates |> List.tryHead
                      resolution = "single_candidate"
                      ambiguous = false
                      ambiguousReason = None }
                else
                    { winner = None
                      resolution = "ambiguous"
                      ambiguous = true
                      ambiguousReason = Some "No active override mode or unique CWTools overwrite winner was available." }

type private DefinitionCandidate =
    { id: string
      entityType: string
      range: range
      score: int }

let private clamp minimum maximum value = max minimum (min maximum value)

let normalizeOptions options =
    { query = options.query.Trim()
      file = options.file |> Option.map (fun value -> value.Trim()) |> Option.filter (String.IsNullOrWhiteSpace >> not)
      typeName = options.typeName |> Option.map (fun value -> value.Trim()) |> Option.filter (String.IsNullOrWhiteSpace >> not)
      exact = options.exact
      depth = clamp 0 3 options.depth
      maxNodes = clamp 1 100 options.maxNodes
      maxEdges = clamp 1 300 options.maxEdges
      includeMetadata = options.includeMetadata }

let private normalizePath = PathIdentity.normalizeLogicalPath

let private pathMatches filterValue candidate =
    let filterPath = normalizePath filterValue
    let candidatePath = normalizePath candidate
    candidatePath = filterPath || candidatePath.EndsWith("/" + filterPath, StringComparison.Ordinal)

let private queryTokens (query: string) =
    Regex.Matches(query.ToLowerInvariant(), @"[@A-Za-z0-9_.:-]+")
    |> Seq.cast<Match>
    |> Seq.map (fun item -> item.Value)
    |> Seq.filter (fun item -> item.Length >= 2)
    |> Seq.distinct
    |> Seq.truncate 16
    |> Seq.toList

let private definitionScore (options: ExploreOptions) (tokens: string list) (entityType: string) (id: string) (filePath: string) =
    let idLower = id.ToLowerInvariant()
    let typeLower = entityType.ToLowerInvariant()
    let fileLower = normalizePath filePath
    let queryLower = options.query.ToLowerInvariant()
    let mutable score = 0

    if String.IsNullOrWhiteSpace options.query then
        score <- 100
    elif options.exact then
        if idLower = queryLower then score <- 1200
    else
        if idLower = queryLower then score <- 1200
        elif idLower.StartsWith(queryLower, StringComparison.Ordinal) then score <- 700
        elif idLower.Contains(queryLower, StringComparison.Ordinal) then score <- 450
        elif typeLower = queryLower then score <- 300
        elif fileLower.Contains(queryLower, StringComparison.Ordinal) then score <- 180

        for token in tokens do
            if idLower = token then score <- score + 350
            elif idLower.StartsWith(token, StringComparison.Ordinal) then score <- score + 140
            elif idLower.Contains(token, StringComparison.Ordinal) then score <- score + 80
            if typeLower = token then score <- score + 100
            if fileLower.Contains(token, StringComparison.Ordinal) then score <- score + 30

    score

let private originForPath path =
    let value = normalizePath path
    if String.IsNullOrWhiteSpace value || value = "-1" then "embedded"
    else
        let roots = PdxShaderProject.configuredLoadOrderRoots ()
        match PdxShaderProject.originForResourceWithRoots roots "" path with
        | PdxShaderProject.Dependency _ -> "dependency"
        | PdxShaderProject.Vanilla -> "vanilla"
        | _ -> "workspace"

let private originForResource scope path =
    match PdxShaderProject.originForResource scope path with
    | PdxShaderProject.Dependency _ -> "dependency"
    | PdxShaderProject.Vanilla -> "vanilla"
    | _ -> originForPath path

let private configuredLoadOrderForPath origin path =
    if origin = "vanilla" then 0, Some "vanilla"
    else
        let candidate = PdxShaderProject.canonicalizePath path
        PdxShaderProject.configuredLoadOrderRoots ()
        |> List.mapi (fun index root -> index, root)
        |> List.filter (fun (_, root) ->
            candidate = root.path
            || (candidate.Length > root.path.Length
                && candidate.StartsWith(root.path, StringComparison.Ordinal)
                && candidate[root.path.Length] = '/'))
        |> List.sortByDescending (fun (_, root) -> root.path.Length)
        |> List.tryHead
        |> Option.map (fun (index, root) -> index + 1, Some root.name)
        |> Option.defaultValue (Int32.MaxValue - 1, None)

let private itemKey (item: GraphDataItem) =
    let file = item.location |> Option.map (fun range -> normalizePath range.FileName) |> Option.defaultValue ""
    $"{item.entityType.ToLowerInvariant()}::{item.id.ToLowerInvariant()}::{file}"

let private candidateKey (candidate: DefinitionCandidate) =
    $"{candidate.entityType.ToLowerInvariant()}::{candidate.id.ToLowerInvariant()}::{normalizePath candidate.range.FileName}"

let private candidateToGraphItem candidate =
    { GraphDataItem.id = candidate.id
      displayName = None
      documentation = None
      references = []
      location = Some candidate.range
      details = None
      isPrimary = true
      entityType = candidate.entityType
      entityTypeDisplayName = None
      abbreviation = None }

let private graphItemScore (seedKeys: HashSet<string>) options tokens (item: GraphDataItem) =
    let file = item.location |> Option.map (fun range -> range.FileName) |> Option.defaultValue ""
    let baseScore = definitionScore options tokens item.entityType item.id file
    baseScore + (if seedKeys.Contains(itemKey item) then 2000 else 0) + (if item.isPrimary then 100 else 0)

let jsonRecord fields = fields |> List.choose id |> List.toArray |> JsonValue.Record

let jsonStringArray values =
    values |> Seq.map JsonValue.String |> Seq.toArray |> JsonValue.Array

let activeModelFreshnessRecord freshness staleReasons =
    jsonRecord
        [ Some("status", JsonValue.String freshness)
          Some("source", JsonValue.String "active_lsp_model")
          Some("staleReasons", jsonStringArray staleReasons) ]

let private rangeFields (location: range option) =
    match location with
    | None -> []
    | Some value ->
        [ Some("file", JsonValue.String(value.FileName.Replace('\\', '/')))
          Some("line", JsonValue.Number(decimal (int value.StartLine)))
          Some("column", JsonValue.Number(decimal (int value.StartColumn)))
          Some("endLine", JsonValue.Number(decimal (int value.EndLine)))
          Some("endColumn", JsonValue.Number(decimal (int value.EndColumn))) ]

let private detailsJson details =
    details
    |> Map.toArray
    |> Array.map (fun (key, values) -> key, jsonStringArray values)
    |> JsonValue.Record

let private nodeJson includeMetadata (item: GraphDataItem) =
    let origin = item.location |> Option.map (fun location -> originForPath location.FileName) |> Option.defaultValue "embedded"
    jsonRecord
        ([ Some("key", JsonValue.String(itemKey item))
           Some("id", JsonValue.String item.id)
           Some("entityType", JsonValue.String item.entityType)
           Some("origin", JsonValue.String origin)
           Some("isPrimary", JsonValue.Boolean item.isPrimary)
           Some("referenceCount", JsonValue.Number(decimal item.references.Length))
           item.displayName |> Option.map (fun value -> "displayName", JsonValue.String value)
           item.entityTypeDisplayName |> Option.map (fun value -> "entityTypeDisplayName", JsonValue.String value)
           item.abbreviation |> Option.map (fun value -> "abbreviation", JsonValue.String value)
           if includeMetadata then item.documentation |> Option.map (fun value -> "documentation", JsonValue.String value) else None
           if includeMetadata then item.details |> Option.map (fun value -> "details", detailsJson value) else None ]
         @ rangeFields item.location)

let private edgeKindForTarget (targetType: string option) =
    if targetType |> Option.exists (String.IsNullOrWhiteSpace >> not) then "typed_reference"
    else "reference"

let private buildEdges maxEdges (nodes: GraphDataItem list) =
    let nodesById = Dictionary<string, GraphDataItem>(StringComparer.OrdinalIgnoreCase)
    for node in nodes do
        match nodesById.TryGetValue node.id with
        | false, _ -> nodesById[node.id] <- node
        | true, existing when originForPath (existing.location |> Option.map (fun value -> value.FileName) |> Option.defaultValue "") = "vanilla"
                              && originForPath (node.location |> Option.map (fun value -> value.FileName) |> Option.defaultValue "") = "workspace" ->
            nodesById[node.id] <- node
        | _ -> ()

    let edges = ResizeArray<JsonValue>()
    let seen = HashSet<string>(StringComparer.Ordinal)

    for node in nodes do
        for targetId, isOutgoing, label in node.references do
            if edges.Count < maxEdges then
                let resolved, targetNode =
                    match nodesById.TryGetValue targetId with
                    | true, value -> true, Some value
                    | false, _ -> false, None
                let nodeEndpoint = itemKey node
                let referenceEndpoint = targetNode |> Option.map itemKey |> Option.defaultValue ("external::" + targetId.ToLowerInvariant())
                let source, target, sourceId, targetEntityId, targetType =
                    if isOutgoing then
                        nodeEndpoint, referenceEndpoint, node.id, targetId, targetNode |> Option.map (fun value -> value.entityType)
                    else
                        referenceEndpoint, nodeEndpoint, targetId, node.id, Some node.entityType
                let labelKey = label |> Option.defaultValue ""
                let edgeKey = $"{source}|{target}|{labelKey}"
                if seen.Add edgeKey then
                    let line = node.location |> Option.map (fun value -> int value.StartLine)
                    edges.Add(
                        jsonRecord
                            [ Some("source", JsonValue.String source)
                              Some("target", JsonValue.String target)
                              Some("sourceId", JsonValue.String sourceId)
                              Some("targetId", JsonValue.String targetEntityId)
                              Some("kind", JsonValue.String(edgeKindForTarget targetType))
                              targetType |> Option.map (fun value -> "targetType", JsonValue.String value)
                              Some("isOutgoing", JsonValue.Boolean isOutgoing)
                              Some("direction", JsonValue.String "source_to_target")
                              Some("causality", JsonValue.String "typed_reference_only")
                              Some("resolved", JsonValue.Boolean resolved)
                              Some("provenance", JsonValue.String "cwtools-computed")
                              Some("confidence", JsonValue.String "semantic")
                              label |> Option.map (fun value -> "label", JsonValue.String value)
                              line |> Option.map (fun value -> "line", JsonValue.Number(decimal value)) ])
    edges |> Seq.toList

let private referenceFactJson typeGroup (reference: ReferenceDetails) =
    let name = stringManager.GetStringForIDs reference.name
    let originalValue = stringManager.GetStringForIDs reference.originalValue
    jsonRecord
        [ Some("typeGroup", JsonValue.String typeGroup)
          Some("name", JsonValue.String name)
          Some("originalValue", JsonValue.String originalValue)
          Some("line", JsonValue.Number(decimal (int reference.position.StartLine)))
          Some("column", JsonValue.Number(decimal (int reference.position.StartColumn)))
          Some("isOutgoing", JsonValue.Boolean reference.isOutgoing)
          Some("direction", JsonValue.String(if reference.isOutgoing then "source_to_target" else "target_to_source"))
          Some("causality", JsonValue.String "typed_reference_only")
          Some("referenceType", JsonValue.String(reference.referenceType.ToString()))
          reference.referenceLabel |> Option.map (fun value -> "label", JsonValue.String value)
          reference.associatedType |> Option.map (fun value -> "associatedType", JsonValue.String value) ]

let private fileFactsJson maxFacts (game: IGame<'T>) selectedFiles =
    let wantedFiles = HashSet<string>(selectedFiles |> Seq.map normalizePath, StringComparer.OrdinalIgnoreCase)
    game.AllEntities()
    |> Seq.filter (fun struct (entity, _) -> wantedFiles.Contains(normalizePath entity.filepath))
    |> Seq.truncate 12
    |> Seq.map (fun struct (entity, lazyData) ->
        let data = lazyData.Force()
        let references =
            data.Referencedtypes
            |> Option.map (fun groups ->
                groups
                |> Map.toSeq
                |> Seq.collect (fun (typeGroup, values) -> values |> Seq.map (referenceFactJson typeGroup))
                |> Seq.truncate maxFacts
                |> Seq.toArray)
            |> Option.defaultValue [||]
        let definedVariables =
            data.Definedvariables
            |> Option.map (fun groups ->
                groups
                |> Map.toSeq
                |> Seq.collect (fun (variableType, values) ->
                    values
                    |> Seq.map (fun (name, position) ->
                        jsonRecord
                            [ Some("variableType", JsonValue.String variableType)
                              Some("name", JsonValue.String name)
                              Some("line", JsonValue.Number(decimal (int position.StartLine))) ]))
                |> Seq.truncate maxFacts
                |> Seq.toArray)
            |> Option.defaultValue [||]
        let eventTargets =
            data.SavedEventTargets
            |> Option.map (fun values ->
                values
                |> Seq.truncate maxFacts
                |> Seq.map (fun (name, position, scope) ->
                    jsonRecord
                        [ Some("name", JsonValue.String name)
                          Some("scope", JsonValue.String(scope.ToString()))
                          Some("line", JsonValue.Number(decimal (int position.StartLine))) ])
                |> Seq.toArray)
            |> Option.defaultValue [||]
        let blockArray (values: CWTools.Process.Node list option) =
            values
            |> Option.defaultValue []
            |> Seq.truncate maxFacts
            |> Seq.map (fun node ->
                jsonRecord
                    [ Some("key", JsonValue.String node.Key)
                      Some("line", JsonValue.Number(decimal (int node.Position.StartLine))) ])
            |> Seq.toArray
        jsonRecord
            [ Some("file", JsonValue.String(entity.filepath.Replace('\\', '/')))
              Some("logicalPath", JsonValue.String entity.logicalpath)
              Some("referencedTypes", JsonValue.Array references)
              Some("definedVariables", JsonValue.Array definedVariables)
              Some("savedEventTargets", JsonValue.Array eventTargets)
              Some("effectBlocks", JsonValue.Array(blockArray data.EffectBlocks))
              Some("triggerBlocks", JsonValue.Array(blockArray data.TriggerBlocks))
              Some("truncated", JsonValue.Boolean(
                  references.Length >= maxFacts
                  || definedVariables.Length >= maxFacts
                  || eventTargets.Length >= maxFacts)) ])
    |> Seq.toArray

let exploreProject (game: IGame<'T>) rawOptions runtime =
    let options = normalizeOptions rawOptions
    let tokens = queryTokens options.query
    let candidates =
        game.Types()
        |> Map.toSeq
        |> Seq.collect (fun (entityType, values) ->
            values
            |> Seq.choose (fun definition ->
                let typeMatches =
                    options.typeName
                    |> Option.map (fun requested -> String.Equals(requested, entityType, StringComparison.OrdinalIgnoreCase))
                    |> Option.defaultValue true
                let fileMatches =
                    options.file
                    |> Option.map (fun requested -> pathMatches requested definition.range.FileName)
                    |> Option.defaultValue true
                if not typeMatches || not fileMatches then None
                else
                    let score = definitionScore options tokens entityType definition.id definition.range.FileName
                    if score <= 0 then None
                    else Some { id = definition.id; entityType = entityType; range = definition.range; score = score }))
        |> Seq.sortByDescending (fun candidate -> candidate.score)
        |> Seq.truncate (min 12 options.maxNodes)
        |> Seq.toList

    let seedKeys = HashSet<string>(candidates |> Seq.map candidateKey, StringComparer.Ordinal)
    let graphGroups =
        candidates
        |> Seq.map (fun candidate -> candidate.range.FileName, candidate.entityType)
        |> Seq.distinct
        |> Seq.truncate 8
        |> Seq.toList

    let expandedItems =
        graphGroups
        |> Seq.collect (fun (fileName, entityType) ->
            try game.GetEventGraphData [ fileName ] entityType options.depth :> seq<GraphDataItem>
            with ex ->
                eprintfn $"[SemanticGraph] Failed to expand event graph for %s{fileName} (%s{entityType}): %s{ex.Message}"
                Seq.empty)
        |> Seq.toList

    let seedItems = candidates |> List.map candidateToGraphItem
    let allItems =
        Seq.append seedItems expandedItems
        |> Seq.distinctBy itemKey
        |> Seq.sortByDescending (graphItemScore seedKeys options tokens)
        |> Seq.toList
    let nodes = allItems |> List.truncate options.maxNodes
    let edges = buildEdges options.maxEdges nodes
    let selectedFiles =
        nodes
        |> Seq.choose (fun node -> node.location |> Option.map (fun location -> location.FileName))
        |> Seq.distinct
        |> Seq.truncate 12
        |> Seq.toList
    let fileFacts = fileFactsJson (min 100 options.maxEdges) game selectedFiles
    let availableEdgeCount = nodes |> Seq.sumBy (fun node -> node.references.Length)
    let warnings = ResizeArray<string>()
    if candidates.IsEmpty then warnings.Add("No typed CWTools definitions matched the query. Try an exact identifier, a typeName, or a file filter.")
    if graphGroups.Length >= 8 && candidates.Length > 8 then warnings.Add("Graph expansion was limited to the eight highest-ranked file/type entry points.")
    if allItems.Length > nodes.Length then warnings.Add("Node results were truncated by maxNodes.")
    if availableEdgeCount > edges.Length then warnings.Add("Edge results were truncated by maxEdges or deduplicated.")
    if runtime.status <> "ready" then warnings.Add("The graph was read from a loading or updating CWTools snapshot; inspect freshness before relying on absence.")

    jsonRecord
        [ Some("ok", JsonValue.Boolean true)
          Some("status", JsonValue.String runtime.status)
          Some("source", JsonValue.String "cwtools-semantic-graph")
          Some("graphVersion", JsonValue.Number(decimal runtime.graphVersion))
          Some("generatedAtUnixMs", JsonValue.Number(decimal (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())))
          Some("query", jsonRecord
              [ Some("text", JsonValue.String options.query)
                options.file |> Option.map (fun value -> "file", JsonValue.String value)
                options.typeName |> Option.map (fun value -> "typeName", JsonValue.String value)
                Some("exact", JsonValue.Boolean options.exact)
                Some("depth", JsonValue.Number(decimal options.depth)) ])
          Some("budget", jsonRecord
              [ Some("maxNodes", JsonValue.Number(decimal options.maxNodes))
                Some("maxEdges", JsonValue.Number(decimal options.maxEdges))
                Some("returnedNodes", JsonValue.Number(decimal nodes.Length))
                Some("returnedEdges", JsonValue.Number(decimal edges.Length))
                Some("availableNodes", JsonValue.Number(decimal allItems.Length))
                Some("availableEdges", JsonValue.Number(decimal availableEdgeCount))
                Some("truncated", JsonValue.Boolean(allItems.Length > nodes.Length || availableEdgeCount > edges.Length)) ])
          Some("entryPoints", JsonValue.Array(candidates |> List.map candidateToGraphItem |> List.map (nodeJson false) |> List.toArray))
          Some("nodes", JsonValue.Array(nodes |> List.map (nodeJson options.includeMetadata) |> List.toArray))
          Some("edges", JsonValue.Array(edges |> List.toArray))
          Some("fileFacts", JsonValue.Array fileFacts)
          Some("freshness", jsonRecord
              [ Some("validationInProgress", JsonValue.Boolean runtime.validationInProgress)
                Some("loadingInProgress", JsonValue.Boolean runtime.loadingInProgress)
                Some("pendingGlobalKinds", jsonStringArray runtime.pendingGlobalKinds)
                Some("lastGlobalRefreshAtUnixMs", JsonValue.Number(decimal runtime.lastGlobalRefreshAtUnixMs)) ])
          Some("warnings", jsonStringArray warnings) ]

let rec private descendantNodes (node: CWTools.Process.Node) =
    seq {
        yield node
        for child in node.Nodes do
            yield! descendantNodes child
    }

let private itemKeyFromRange (range: range) =
    normalizePath range.FileName

type SemanticFieldFact =
    { path: string
      key: string
      occurrence: int
      value: string
      file: string
      line: int }

/// Flatten a definition recursively without discarding repeated keys. Node
/// identity fields make paths stable across formatting and sibling insertion;
/// an occurrence suffix remains for anonymous/repeated clauses.
let collectSemanticFields (node: CWTools.Process.Node) =
    let facts = ResizeArray<SemanticFieldFact>()
    let clean (value: string) = value.Trim().Trim('"')
    let identityFor (child: CWTools.Process.Node) =
        child.Values
        |> Seq.tryFind (fun value ->
            value.Key.Equals("id", StringComparison.OrdinalIgnoreCase)
            || value.Key.Equals("key", StringComparison.OrdinalIgnoreCase)
            || value.Key.Equals("name", StringComparison.OrdinalIgnoreCase))
        |> Option.map (fun value -> clean (string value.Value))
        |> Option.filter (String.IsNullOrWhiteSpace >> not)
    let rec visit prefix (current: CWTools.Process.Node) =
        let valueOccurrences = Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
        for value in current.Values do
            let key = value.Key.ToLowerInvariant()
            let occurrence = match valueOccurrences.TryGetValue key with true, count -> count | _ -> 0
            valueOccurrences.[key] <- occurrence + 1
            let fieldPath = if String.IsNullOrWhiteSpace prefix then sprintf "%s[%d]" key occurrence else sprintf "%s.%s[%d]" prefix key occurrence
            facts.Add
                { path = fieldPath
                  key = key
                  occurrence = occurrence
                  value = clean (string value.Value)
                  file = normalizePath value.Position.FileName
                  line = int value.Position.StartLine }
        let nodeOccurrences = Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
        for child in current.Nodes do
            let key = child.Key.ToLowerInvariant()
            let occurrence = match nodeOccurrences.TryGetValue key with true, count -> count | _ -> 0
            nodeOccurrences.[key] <- occurrence + 1
            let identity = identityFor child |> Option.defaultValue (string occurrence)
            let segment = sprintf "%s[%s]" key identity
            let childPrefix = if String.IsNullOrWhiteSpace prefix then segment else prefix + "." + segment
            visit childPrefix child
    visit "" node
    facts |> Seq.toList

/// Field-level comparison of a workspace definition against its vanilla
/// counterpart. Candidates are matched by (entityType, id); the workspace
/// block and the vanilla block are aligned by recursive semantic paths and
/// occurrences. Formatting and comment
/// differences are never treated as semantic changes.
let compareDefinitionWithVanillaWithRuntime (shouldCancel: unit -> bool) freshness staleReasons (game: IGame<'T>) (entityType: string) (symbolId: string) =
    let checkCancelled () = if shouldCancel () then raise (OperationCanceledException("Definition comparison was cancelled."))
    checkCancelled ()
    let candidates =
        game.Types()
        |> Map.tryFind entityType
        |> Option.defaultValue [||]
        |> Array.filter (fun definition -> String.Equals(definition.id, symbolId, StringComparison.OrdinalIgnoreCase))
    let resourceInfo = Dictionary<string, string * CWTools.Games.Overwrite * string>(StringComparer.OrdinalIgnoreCase)
    for resource in game.AllFiles() do
        checkCancelled ()
        match resource with
        | EntityResource(_, item) -> resourceInfo.[normalizePath item.filepath] <- normalizePath item.logicalpath, item.overwrite, item.scope
        | FileWithContentResource(_, item) -> resourceInfo.[normalizePath item.filepath] <- normalizePath item.logicalpath, item.overwrite, item.scope
        | FileResource(_, item) -> resourceInfo.[normalizePath item.filepath] <- normalizePath item.logicalpath, CWTools.Games.Overwrite.No, item.scope
    let logicalPathFor file =
        match resourceInfo.TryGetValue(normalizePath file) with
        | true, (logicalPath, _, _) -> logicalPath
        | _ -> normalizePath file
    let overwriteFor file =
        match resourceInfo.TryGetValue(normalizePath file) with
        | true, (_, overwrite, _) -> overwrite
        | _ -> CWTools.Games.Overwrite.No
    let originForDefinition file =
        match resourceInfo.TryGetValue(normalizePath file) with
        | true, (_, _, scope) -> originForResource scope file
        | _ -> originForPath file
    let ordered =
        candidates
        |> Array.sortBy (fun definition ->
            let file = definition.range.FileName
            let rank, _ = configuredLoadOrderForPath (originForDefinition file) file
            rank, logicalPathFor file, normalizePath file, int definition.range.StartLine)
    let workspace = ordered |> Array.filter (fun definition -> originForDefinition definition.range.FileName = "workspace") |> Array.tryLast
    let dependencies = ordered |> Array.filter (fun definition -> originForDefinition definition.range.FileName = "dependency")
    let vanilla = ordered |> Array.filter (fun definition -> originForDefinition definition.range.FileName = "vanilla") |> Array.tryHead
    let workspaceItem = workspace |> Option.map (fun item -> itemKeyFromRange item.range)
    let vanillaItem = vanilla |> Option.map (fun item -> itemKeyFromRange item.range)
    let semanticFields (range: range) =
        game.AllEntities()
        |> Seq.tryFind (fun struct (entity, _) -> normalizePath entity.filepath = normalizePath range.FileName)
        |> Option.map (fun struct (entity, _) ->
            let block =
                entity.rawEntity
                |> descendantNodes
                |> Seq.filter (fun node ->
                    int node.Position.StartLine = int range.StartLine
                    && int node.Position.EndLine = int range.EndLine)
                |> Seq.tryHead
            match block with
            | None -> []
            | Some node -> collectSemanticFields node)
        |> Option.defaultValue []
    let workspaceFields = workspace |> Option.map (fun item -> semanticFields item.range) |> Option.defaultValue []
    let vanillaFields = vanilla |> Option.map (fun item -> semanticFields item.range) |> Option.defaultValue []
    let byPath values = values |> Seq.map (fun item -> item.path, item) |> Map.ofSeq
    let workspaceByPath = byPath workspaceFields
    let vanillaByPath = byPath vanillaFields
    let added =
        workspaceByPath
        |> Map.toSeq
        |> Seq.filter (fun (key, _) -> not (vanillaByPath.ContainsKey key))
        |> Seq.map snd
        |> Seq.sortBy (fun item -> item.path)
        |> Seq.toList
    let removed =
        vanillaByPath
        |> Map.toSeq
        |> Seq.filter (fun (key, _) -> not (workspaceByPath.ContainsKey key))
        |> Seq.map snd
        |> Seq.sortBy (fun item -> item.path)
        |> Seq.toList
    let modified =
        workspaceByPath
        |> Map.toSeq
        |> Seq.choose (fun (key, workspaceValue) ->
            match vanillaByPath.TryFind key with
            | Some vanillaValue when not (String.Equals(workspaceValue.value, vanillaValue.value, StringComparison.OrdinalIgnoreCase)) ->
                Some(key, vanillaValue, workspaceValue)
            | _ -> None)
        |> Seq.sortBy (fun (key, _, _) -> key)
        |> Seq.toList
    let commonVanillaOrder = vanillaFields |> List.map (fun item -> item.path) |> List.filter workspaceByPath.ContainsKey
    let commonWorkspaceOrder = workspaceFields |> List.map (fun item -> item.path) |> List.filter vanillaByPath.ContainsKey
    let vanillaOrder = commonVanillaOrder |> List.indexed |> List.map (fun (index, field) -> field, index) |> Map.ofList
    let workspaceOrder = commonWorkspaceOrder |> List.indexed |> List.map (fun (index, field) -> field, index) |> Map.ofList
    let orderChanged =
        commonWorkspaceOrder
        |> List.choose (fun field ->
            match vanillaOrder.TryFind field, workspaceOrder.TryFind field with
            | Some vanillaIndex, Some workspaceIndex when vanillaIndex <> workspaceIndex -> Some(field, vanillaIndex, workspaceIndex)
            | _ -> None)
        |> List.truncate 200
    let fieldJson (field: SemanticFieldFact) =
        jsonRecord
            [ Some("field", JsonValue.String field.key)
              Some("path", JsonValue.String field.path)
              Some("occurrence", JsonValue.Number(decimal field.occurrence))
              Some("value", JsonValue.String field.value)
              Some("source", jsonRecord [ Some("file", JsonValue.String field.file); Some("line", JsonValue.Number(decimal field.line)) ]) ]
    let modifiedJson (key: string, vanillaValue: SemanticFieldFact, workspaceValue: SemanticFieldFact) =
        jsonRecord
            [ Some("field", JsonValue.String key)
              Some("vanillaValue", JsonValue.String vanillaValue.value)
              Some("workspaceValue", JsonValue.String workspaceValue.value)
              Some("vanillaSource", jsonRecord [ Some("file", JsonValue.String vanillaValue.file); Some("line", JsonValue.Number(decimal vanillaValue.line)) ])
              Some("workspaceSource", jsonRecord [ Some("file", JsonValue.String workspaceValue.file); Some("line", JsonValue.Number(decimal workspaceValue.line)) ]) ]
    let active = ordered |> Array.filter (fun definition -> overwriteFor definition.range.FileName <> CWTools.Games.Overwrite.Overwritten)
    let strategy =
        ordered
        |> Array.tryPick (fun definition -> game.OverrideModeAtPath(logicalPathFor definition.range.FileName) |> Option.map (fun mode -> mode.strategy.ToUpperInvariant()))
    let activeWinner = if active.Length = 1 then Some active.[0] else None
    let resolutionResult =
        OverrideResolver.resolveWinner
            strategy
            (active.Length = 1)
            activeWinner
            (ordered |> Array.toList)
    let winner, resolution, ambiguous, ambiguousReason =
        resolutionResult.winner, resolutionResult.resolution, resolutionResult.ambiguous, resolutionResult.ambiguousReason
    let candidateJson (definition: CWTools.Common.NewScope.TypeDefInfo) =
        let file = definition.range.FileName
        let origin = originForDefinition file
        let loadOrderIndex, loadOrderRoot = configuredLoadOrderForPath origin file
        jsonRecord
            [ Some("file", JsonValue.String(itemKeyFromRange definition.range))
              Some("logicalPath", JsonValue.String(logicalPathFor file))
              Some("origin", JsonValue.String origin)
              Some("loadOrderIndex", JsonValue.Number(decimal loadOrderIndex))
              loadOrderRoot |> Option.map (fun value -> "loadOrderRoot", JsonValue.String value)
              Some("line", JsonValue.Number(decimal (int definition.range.StartLine))) ]
    jsonRecord
        [ Some("ok", JsonValue.Boolean true)
          Some("entityType", JsonValue.String entityType)
          Some("symbolId", JsonValue.String symbolId)
          Some("workspace", jsonRecord
              [ Some("present", JsonValue.Boolean workspace.IsSome)
                workspaceItem |> Option.map (fun value -> "file", JsonValue.String value) ])
          Some("vanilla", jsonRecord
              [ Some("present", JsonValue.Boolean vanilla.IsSome)
                vanillaItem |> Option.map (fun value -> "file", JsonValue.String value) ])
          Some("dependencies", JsonValue.Array(dependencies |> Array.map candidateJson))
          Some("added", JsonValue.Array(added |> List.map fieldJson |> List.toArray))
          Some("removed", JsonValue.Array(removed |> List.map fieldJson |> List.toArray))
          Some("modified", JsonValue.Array(modified |> List.map modifiedJson |> List.toArray))
          Some("orderChanged", JsonValue.Array(orderChanged |> List.map (fun (field, vanillaIndex, workspaceIndex) ->
              jsonRecord
                  [ Some("field", JsonValue.String field)
                    Some("vanillaOrder", JsonValue.Number(decimal vanillaIndex))
                    Some("workspaceOrder", JsonValue.Number(decimal workspaceIndex)) ]) |> List.toArray))
          Some("candidates", JsonValue.Array(ordered |> Array.map candidateJson))
          winner |> Option.map (fun value -> "winner", candidateJson value)
          Some("resolution", JsonValue.String resolution)
          Some("ambiguous", JsonValue.Boolean ambiguous)
          ambiguousReason |> Option.map (fun value -> "ambiguousReason", JsonValue.String value)
          Some("coverage", jsonRecord
              [ Some("filesConsidered", JsonValue.Number(decimal (ordered |> Seq.map (fun item -> normalizePath item.range.FileName) |> Seq.distinct |> Seq.length)))
                Some("filesIndexed", JsonValue.Number(decimal (ordered |> Seq.map (fun item -> normalizePath item.range.FileName) |> Seq.distinct |> Seq.length)))
                Some("definitionsConsidered", JsonValue.Number(decimal ordered.Length))
                Some("definitionsIndexed", JsonValue.Number(decimal ordered.Length))
                Some("candidatesConsidered", JsonValue.Number(decimal ordered.Length))
                Some("workspaceFields", JsonValue.Number(decimal workspaceFields.Length))
                Some("vanillaFields", JsonValue.Number(decimal vanillaFields.Length))
                Some("truncated", JsonValue.Boolean false)
                Some("staleReasons", jsonStringArray staleReasons)
                Some("unsupportedConstructs", jsonStringArray [ "runtime_merge_side_effects" ]) ])
          Some("freshness", activeModelFreshnessRecord freshness staleReasons)
          Some("version", JsonValue.Number 2m)
          Some("confidence", JsonValue.String "cwtools-aligned-recursive") ]

let compareDefinitionWithVanilla game entityType symbolId =
    compareDefinitionWithVanillaWithRuntime (fun () -> false) "fresh" [] game entityType symbolId
