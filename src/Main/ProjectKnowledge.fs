module Main.ProjectKnowledge

open System
open System.Collections.Generic
open System.IO
open FSharp.Data
open CWTools.Games
open CWTools.Utilities.Position
open CWTools.Utilities.StringResource

type ExportOptions =
    { domains: string list
      maxDefinitions: int
      maxTopologyFiles: int
      maxEdges: int
      archetypesPerDomain: int }

type RuntimeMetadata =
    { graphVersion: int64
      status: string
      validationInProgress: bool
      loadingInProgress: bool
      pendingGlobalKinds: string list
      lastGlobalRefreshAtUnixMs: int64 }

type private ResourceFact =
    { file: string
      logicalPath: string
      scope: string
      overwrite: string }

type private DefinitionFact =
    { id: string
      entityType: string
      file: string
      logicalPath: string
      line: int
      endLine: int
      origin: string
      validate: bool
      subtypes: string list
      overwrite: string
      resourceScope: string option
      domain: string
      overridePath: string option
      overrideStrategy: string option }

let private clamp minimum maximum value = max minimum (min maximum value)

let normalizeOptions options =
    { domains =
        options.domains
        |> List.map (fun value -> value.Trim().ToLowerInvariant())
        |> List.filter (String.IsNullOrWhiteSpace >> not)
        |> List.distinct
      maxDefinitions = clamp 100 20000 options.maxDefinitions
      maxTopologyFiles = clamp 10 3000 options.maxTopologyFiles
      maxEdges = clamp 100 20000 options.maxEdges
      archetypesPerDomain = clamp 1 20 options.archetypesPerDomain }

let private normalizePath (value: string) =
    value.Replace('\\', '/').Trim()

let private comparison =
    if OperatingSystem.IsWindows() then StringComparison.OrdinalIgnoreCase
    else StringComparison.Ordinal

let private pathInside root candidate =
    try
        let rootFull = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
        let candidateFull = Path.GetFullPath(candidate)
        candidateFull.Equals(rootFull, comparison)
        || candidateFull.StartsWith(rootFull + string Path.DirectorySeparatorChar, comparison)
        || candidateFull.StartsWith(rootFull + string Path.AltDirectorySeparatorChar, comparison)
    with _ -> false

let private originForPath projectRoots filePath =
    if projectRoots |> List.exists (fun root -> pathInside root filePath) then "workspace"
    else "vanilla"

let private overwriteName = function
    | Overwrite.Overwrote -> "overwrote"
    | Overwrite.Overwritten -> "overwritten"
    | _ -> "none"

let private resourceFacts (game: IGame) =
    let comparer = if OperatingSystem.IsWindows() then StringComparer.OrdinalIgnoreCase else StringComparer.Ordinal
    let table = Dictionary<string, ResourceFact>(comparer)
    let add (fact: ResourceFact) =
        let key = normalizePath fact.file
        if not (table.ContainsKey key) then table.[key] <- fact
    for resource in game.AllFiles() do
        match resource with
        | EntityResource(_, item) ->
            add
                { file = item.filepath
                  logicalPath = item.logicalpath
                  scope = item.scope
                  overwrite = overwriteName item.overwrite }
        | FileResource(_, item) ->
            add
                { file = item.filepath
                  logicalPath = item.logicalpath
                  scope = item.scope
                  overwrite = "none" }
        | FileWithContentResource(_, item) ->
            add
                { file = item.filepath
                  logicalPath = item.logicalpath
                  scope = item.scope
                  overwrite = overwriteName item.overwrite }
    table :> IDictionary<string, ResourceFact>

let private domainFor entityType logicalPath =
    let value = (entityType + " " + logicalPath).ToLowerInvariant()
    if value.Contains("on_action") then "on_actions"
    elif value.Contains("special_project") then "special_projects"
    elif value.Contains("archaeolog") || value.Contains("archaeological_site") then "archaeology"
    elif value.Contains("situation") then "situations"
    elif value.Contains("technology") || value.Contains("technolog") then "technology"
    elif value.Contains("ship_") || value.Contains("component_template") || value.Contains("section_template") || value.Contains("starbase") then "ships"
    elif value.Contains("scripted_effect") || value.Contains("scripted_trigger") || value.Contains("scripted_value") then "scripted_logic"
    elif value.Contains("event") then "events"
    elif value.Contains("sprite") || value.Contains("asset") || value.Contains("interface") || value.Contains("gfx/") || value.Contains("sound") || value.Contains("music") then "assets"
    elif value.Contains("localisation") || value.Contains("localization") then "localisation"
    else
        let normalized = (normalizePath (logicalPath.TrimStart('/'))).ToLowerInvariant()
        let segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries)
        let commonIndex = segments |> Array.tryFindIndex (fun segment -> segment = "common")
        match commonIndex with
        | Some index when index + 1 < segments.Length -> segments.[index + 1].Replace('-', '_')
        | _ when segments |> Array.exists (fun segment -> segment = "map" || segment = "map_data") -> "map"
        | _ -> "other"

let private jsonStringArray values =
    values |> Seq.map JsonValue.String |> Seq.toArray |> JsonValue.Array

let private jsonRecord fields =
    fields |> List.choose id |> List.toArray |> JsonValue.Record

let private resourceForFile (resources: IDictionary<string, ResourceFact>) file =
    match resources.TryGetValue(normalizePath file) with
    | true, value -> Some value
    | false, _ -> None

let private definitionJson definition =
    jsonRecord
        [ Some("id", JsonValue.String definition.id)
          Some("entityType", JsonValue.String definition.entityType)
          Some("file", JsonValue.String(normalizePath definition.file))
          Some("logicalPath", JsonValue.String(normalizePath definition.logicalPath))
          Some("line", JsonValue.Number(decimal definition.line))
          Some("endLine", JsonValue.Number(decimal definition.endLine))
          Some("origin", JsonValue.String definition.origin)
          Some("validate", JsonValue.Boolean definition.validate)
          Some("subtypes", jsonStringArray definition.subtypes)
          Some("overwrite", JsonValue.String definition.overwrite)
          definition.resourceScope |> Option.map (fun value -> "resourceScope", JsonValue.String value)
          Some("domain", JsonValue.String definition.domain)
          definition.overridePath |> Option.map (fun value -> "overridePath", JsonValue.String value)
          definition.overrideStrategy |> Option.map (fun value -> "overrideStrategy", JsonValue.String value) ]

let private collectDefinitions (game: IGame) projectRoots resources options =
    game.Types()
    |> Map.toSeq
    |> Seq.collect (fun (entityType, values) ->
        values
        |> Seq.map (fun definition ->
            let resource = resourceForFile resources definition.range.FileName
            let logicalPath = resource |> Option.map (fun item -> item.logicalPath) |> Option.defaultValue definition.range.FileName
            let domain = domainFor entityType logicalPath
            let matchedMode = game.OverrideModeAtPath logicalPath
            { id = definition.id
              entityType = entityType
              file = definition.range.FileName
              logicalPath = logicalPath
              line = int definition.range.StartLine
              endLine = int definition.range.EndLine
              origin = originForPath projectRoots definition.range.FileName
              validate = definition.validate
              subtypes = definition.subtypes
              overwrite = resource |> Option.map (fun item -> item.overwrite) |> Option.defaultValue "none"
              resourceScope = resource |> Option.map (fun item -> item.scope) |> Option.filter (String.IsNullOrWhiteSpace >> not)
              domain = domain
              overridePath = matchedMode |> Option.map (fun item -> item.path)
              overrideStrategy = matchedMode |> Option.map (fun item -> item.strategy) }))
    |> Seq.filter (fun definition -> options.domains.IsEmpty || options.domains |> List.contains definition.domain)
    |> Seq.sortBy (fun definition -> definition.domain, definition.entityType, definition.id, definition.origin)
    |> Seq.truncate options.maxDefinitions
    |> Seq.toList

let private typeSummaries definitions =
    definitions
    |> Seq.groupBy (fun definition -> definition.entityType)
    |> Seq.map (fun (entityType, values) ->
        let items = values |> Seq.toList
        jsonRecord
            [ Some("entityType", JsonValue.String entityType)
              Some("totalCount", JsonValue.Number(decimal items.Length))
              Some("workspaceCount", JsonValue.Number(decimal (items |> List.filter (fun item -> item.origin = "workspace") |> List.length)))
              Some("vanillaCount", JsonValue.Number(decimal (items |> List.filter (fun item -> item.origin = "vanilla") |> List.length))) ])
    |> Seq.sortBy (fun value -> value.ToString())
    |> Seq.toArray

let private definitionStacks definitions =
    definitions
    |> Seq.groupBy (fun definition -> definition.entityType.ToLowerInvariant(), definition.id.ToLowerInvariant())
    |> Seq.choose (fun ((_entityTypeKey, _idKey), values) ->
        let items = values |> Seq.toList
        if items.Length <= 1 then None
        else
            let entityType = items.Head.entityType
            let id = items.Head.id
            let active = items |> List.filter (fun item -> item.overwrite <> "overwritten")
            let origins = items |> List.map (fun item -> item.origin) |> List.distinct
            let resolution =
                if active.Length = 1 then "single_active_definition"
                elif items |> List.exists (fun item -> item.overrideStrategy.IsSome) then "consult_override_mode"
                else "ambiguous"
            Some(
                jsonRecord
                    [ Some("entityType", JsonValue.String entityType)
                      Some("id", JsonValue.String id)
                      Some("origins", jsonStringArray origins)
                      Some("resolution", JsonValue.String resolution)
                      Some("definitions", JsonValue.Array(items |> List.map definitionJson |> List.toArray))
                      Some("activeDefinitions", JsonValue.Array(active |> List.map definitionJson |> List.toArray)) ]))
    |> Seq.truncate 2000
    |> Seq.toArray

let private domainSummaries options definitions =
    definitions
    |> Seq.groupBy (fun definition -> definition.domain)
    |> Seq.map (fun (domain, values) ->
        let items = values |> Seq.toList
        let workspace = items |> List.filter (fun item -> item.origin = "workspace")
        let vanilla = items |> List.filter (fun item -> item.origin = "vanilla")
        let diverseExamples limit source =
            source
            |> Seq.groupBy (fun item -> item.entityType)
            |> Seq.collect (fun (_, group) -> group |> Seq.truncate 2)
            |> Seq.truncate limit
            |> Seq.toList
        let directories = items |> Seq.map (fun item -> normalizePath item.logicalPath |> Path.GetDirectoryName) |> Seq.filter (String.IsNullOrWhiteSpace >> not) |> Seq.distinct |> Seq.truncate 20
        jsonRecord
            [ Some("id", JsonValue.String domain)
              Some("definitionCount", JsonValue.Number(decimal items.Length))
              Some("workspaceCount", JsonValue.Number(decimal workspace.Length))
              Some("vanillaCount", JsonValue.Number(decimal vanilla.Length))
              Some("entityTypes", items |> Seq.map (fun item -> item.entityType) |> Seq.distinct |> Seq.sort |> jsonStringArray |> Some |> Option.get)
              Some("directories", jsonStringArray directories)
              Some("projectExamples", JsonValue.Array(diverseExamples 12 workspace |> List.map definitionJson |> List.toArray))
              Some("vanillaArchetypes", JsonValue.Array(diverseExamples options.archetypesPerDomain vanilla |> List.map definitionJson |> List.toArray)) ])
    |> Seq.sortBy (fun value -> value.ToString())
    |> Seq.toArray

let private topology projectRoots options (game: IGame<'T>) =
    let files = ResizeArray<JsonValue>()
    let edges = ResizeArray<JsonValue>()
    let mutable fileCount = 0

    for struct (entity, lazyData) in game.AllEntities() do
        if fileCount < options.maxTopologyFiles && originForPath projectRoots entity.filepath = "workspace" then
            let domain = domainFor "" entity.logicalpath
            if options.domains.IsEmpty || options.domains |> List.contains domain then
                fileCount <- fileCount + 1
                let data = lazyData.Force()
                let references =
                    data.Referencedtypes
                    |> Option.map (fun groups ->
                        groups
                        |> Map.toSeq
                        |> Seq.collect (fun (typeGroup, values) ->
                            values
                            |> Seq.map (fun reference ->
                                let target = stringManager.GetStringForIDs reference.originalValue
                                if edges.Count < options.maxEdges then
                                    edges.Add(
                                        jsonRecord
                                            [ Some("sourceFile", JsonValue.String(normalizePath entity.filepath))
                                              Some("sourceLogicalPath", JsonValue.String(normalizePath entity.logicalpath))
                                              Some("targetId", JsonValue.String target)
                                              Some("typeGroup", JsonValue.String typeGroup)
                                              Some("line", JsonValue.Number(decimal (int reference.position.StartLine)))
                                              Some("isOutgoing", JsonValue.Boolean reference.isOutgoing)
                                              Some("referenceType", JsonValue.String(reference.referenceType.ToString()))
                                              reference.referenceLabel |> Option.map (fun value -> "label", JsonValue.String value)
                                              reference.associatedType |> Option.map (fun value -> "associatedType", JsonValue.String value) ])
                                target))
                        |> Seq.filter (String.IsNullOrWhiteSpace >> not)
                        |> Seq.distinct
                        |> Seq.truncate 100
                        |> Seq.toArray)
                    |> Option.defaultValue [||]
                files.Add(
                    jsonRecord
                        [ Some("file", JsonValue.String(normalizePath entity.filepath))
                          Some("logicalPath", JsonValue.String(normalizePath entity.logicalpath))
                          Some("domain", JsonValue.String domain)
                          Some("references", jsonStringArray references) ])

    jsonRecord
        [ Some("files", JsonValue.Array(files.ToArray()))
          Some("edges", JsonValue.Array(edges.ToArray()))
          Some("truncated", JsonValue.Boolean(fileCount >= options.maxTopologyFiles || edges.Count >= options.maxEdges)) ]

let private overrideModesJson (game: IGame) =
    game.OverrideModes()
    |> Array.map (fun item ->
        jsonRecord
            [ Some("path", JsonValue.String item.path)
              Some("strategy", JsonValue.String item.strategy) ])

let private overrideModeInfoJson (game: IGame) =
    game.OverrideModesInfo()
    |> Array.map (fun item ->
        jsonRecord
            [ Some("id", JsonValue.String item.id)
              item.name |> Option.map (fun value -> "name", JsonValue.String value)
              item.description |> Option.map (fun value -> "description", JsonValue.String value) ])

let exportProjectKnowledge activeGame projectRoots rawOptions runtime (game: IGame<'T>) =
    let options = normalizeOptions rawOptions
    let resources = resourceFacts (game :> IGame)
    let definitions = collectDefinitions (game :> IGame) projectRoots resources options
    let domains = domainSummaries options definitions
    let warnings = ResizeArray<string>()
    if runtime.status <> "ready" then warnings.Add("The knowledge snapshot was exported while CWTools was loading or stale.")
    if definitions.Length >= options.maxDefinitions then warnings.Add("Definitions were truncated by maxDefinitions.")
    if definitions |> List.exists (fun item -> item.origin = "vanilla") |> not then warnings.Add("No vanilla definitions were detected in the loaded game model.")

    jsonRecord
        [ Some("ok", JsonValue.Boolean true)
          Some("status", JsonValue.String runtime.status)
          Some("source", JsonValue.String "cwtools-project-knowledge")
          Some("schemaVersion", JsonValue.Number 1m)
          Some("game", JsonValue.String activeGame)
          Some("generatedAtUnixMs", JsonValue.Number(decimal (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())))
          Some("graphVersion", JsonValue.Number(decimal runtime.graphVersion))
          Some("projectRoots", jsonStringArray projectRoots)
          Some("requestedDomains", jsonStringArray options.domains)
          Some("definitions", JsonValue.Array(definitions |> List.map definitionJson |> List.toArray))
          Some("typeSummaries", JsonValue.Array(typeSummaries definitions))
          Some("definitionStacks", JsonValue.Array(definitionStacks definitions))
          Some("domains", JsonValue.Array domains)
          Some("topology", topology projectRoots options game)
          Some("overrideModes", JsonValue.Array(overrideModesJson (game :> IGame)))
          Some("overrideModeInfo", JsonValue.Array(overrideModeInfoJson (game :> IGame)))
          Some("freshness", jsonRecord
              [ Some("validationInProgress", JsonValue.Boolean runtime.validationInProgress)
                Some("loadingInProgress", JsonValue.Boolean runtime.loadingInProgress)
                Some("pendingGlobalKinds", jsonStringArray runtime.pendingGlobalKinds)
                Some("lastGlobalRefreshAtUnixMs", JsonValue.Number(decimal runtime.lastGlobalRefreshAtUnixMs)) ])
          Some("warnings", jsonStringArray warnings) ]
