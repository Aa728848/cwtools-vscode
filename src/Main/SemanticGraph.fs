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

let private normalizePath (value: string) =
    value.Replace('\\', '/').Trim().TrimStart('/').ToLowerInvariant()

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
    elif value.Contains("/vanilla/") || value.Contains("/cache/") || value.Contains("/.cwtools/") then "vanilla"
    else "workspace"

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

let private jsonRecord fields = fields |> List.choose id |> List.toArray |> JsonValue.Record

let private jsonStringArray values =
    values |> Seq.map JsonValue.String |> Seq.toArray |> JsonValue.Array

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
    match targetType |> Option.map (fun value -> value.ToLowerInvariant()) with
    | Some value when value.Contains("event") -> "fires_event"
    | Some value when value.Contains("scripted_effect") -> "calls_scripted_effect"
    | Some value when value.Contains("scripted_trigger") -> "calls_scripted_trigger"
    | Some value when value.Contains("localisation") -> "uses_localisation"
    | Some value when value.Contains("sprite") || value.Contains("asset") -> "uses_asset"
    | _ -> "references"

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
                              Some("isOutgoing", JsonValue.Boolean isOutgoing)
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
            with _ -> Seq.empty)
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
