module Main.ProjectKnowledge

open System
open System.Collections.Generic
open System.IO
open System.Text.RegularExpressions
open FSharp.Data
open Microsoft.Data.Sqlite
open CWTools.Games
open CWTools.Utilities.Position
open CWTools.Utilities.StringResource

type ExportOptions =
    { domains: string list
      maxDefinitions: int
      maxTopologyFiles: int
      maxEdges: int
      archetypesPerDomain: int
      databasePath: string option
      generationMode: string }

type RuntimeMetadata =
    { graphVersion: int64
      status: string
      validationInProgress: bool
      loadingInProgress: bool
      pendingGlobalKinds: string list
      lastGlobalRefreshAtUnixMs: int64 }

type QueryOptions =
    { databasePath: string
      intent: string option
      domains: string list
      identifiers: string list
      entityTypes: string list
      includeProjectPatterns: bool
      includeVanillaArchetypes: bool
      includeTopology: bool
      includeUnresolved: bool
      includeEventGraph: bool
      limit: int }

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

type private FileFact =
    { file: string
      logicalPath: string
      domain: string
      origin: string }

type private ReferenceFact =
    { sourceFile: string
      sourceLogicalPath: string
      targetId: string
      typeGroup: string
      line: int
      isOutgoing: bool
      referenceType: string
      label: string option
      associatedType: string option
      domain: string }

type private TopologyFacts =
    { files: FileFact list
      edges: ReferenceFact list
      truncated: bool }

type private EventNodeFact =
    { eventId: string
      eventType: string
      title: string option
      file: string
      logicalPath: string
      line: int
      endLine: int
      origin: string
      isTriggeredOnly: bool
      isHidden: bool
      hasMeanTimeToHappen: bool }

type private EventEdgeFact =
    { sourceKind: string
      sourceId: string
      targetEventId: string
      edgeType: string
      label: string option
      sourceFile: string
      line: int
      confidence: string }

type private EventLogicFact =
    { eventId: string
      relationType: string
      subject: string
      scope: string option
      phase: string
      sourceFile: string
      line: int
      details: string option }

type private EventGraphFacts =
    { nodes: EventNodeFact list
      edges: EventEdgeFact list
      logic: EventLogicFact list }

let private clamp minimum maximum value = max minimum (min maximum value)

let normalizeOptions (options: ExportOptions) : ExportOptions =
    { domains =
        options.domains
        |> List.map (fun value -> value.Trim().ToLowerInvariant())
        |> List.filter (String.IsNullOrWhiteSpace >> not)
        |> List.distinct
      maxDefinitions = clamp 100 250000 options.maxDefinitions
      maxTopologyFiles = clamp 10 3000 options.maxTopologyFiles
      maxEdges = clamp 100 20000 options.maxEdges
      archetypesPerDomain = clamp 1 20 options.archetypesPerDomain
      databasePath = options.databasePath
      generationMode = if options.generationMode = "incremental" then "incremental" else "full" }

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

let private definitionJson (definition: DefinitionFact) =
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

let private collectDefinitions (game: IGame) (projectRoots: string list) (resources: IDictionary<string, ResourceFact>) (options: ExportOptions) : DefinitionFact list =
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
    |> Seq.distinctBy (fun definition -> definition.entityType.ToLowerInvariant(), definition.id.ToLowerInvariant(), normalizePath definition.file, definition.line)
    |> Seq.sortBy (fun definition -> definition.domain, definition.entityType, definition.id, definition.origin)
    |> Seq.toList

let private balancedTakeDefinitions limit (definitions: DefinitionFact list) =
    if limit <= 0 || definitions.IsEmpty then []
    elif definitions.Length <= limit then definitions
    else
        let groups =
            definitions
            |> Seq.groupBy (fun definition -> definition.domain)
            |> Seq.sortBy fst
            |> Seq.map (fun (_, values) -> values |> Seq.toArray)
            |> Seq.toArray
        let selected = ResizeArray<DefinitionFact>(limit)
        let mutable index = 0
        let mutable added = true
        while selected.Count < limit && added do
            added <- false
            for group in groups do
                if selected.Count < limit && index < group.Length then
                    selected.Add(group.[index])
                    added <- true
            index <- index + 1
        selected |> Seq.toList

let private selectDefinitions (options: ExportOptions) (definitions: DefinitionFact list) =
    if definitions.Length <= options.maxDefinitions then definitions
    else
        let workspace, vanilla = definitions |> List.partition (fun item -> item.origin = "workspace")
        let eventCoreDomains = set [ "events"; "on_actions" ]
        let priorityDomains =
            set [ "special_projects"; "archaeology"; "situations"; "technology"; "ships"; "scripted_logic" ]
        let eventCore, remainingVanilla = vanilla |> List.partition (fun item -> eventCoreDomains.Contains item.domain)
        let priority, other = remainingVanilla |> List.partition (fun item -> priorityDomains.Contains item.domain)
        // Event and on_action definitions are mandatory for structural and logic
        // graph completeness, even if an unusually large game exceeds the soft cap.
        let selectedEventCore = eventCore
        let mutable remaining = max 0 (options.maxDefinitions - workspace.Length - selectedEventCore.Length)
        let selectedPriority = balancedTakeDefinitions remaining priority
        remaining <- max 0 (remaining - selectedPriority.Length)
        let selectedOther = balancedTakeDefinitions remaining other
        Seq.concat [ workspace; selectedEventCore; selectedPriority; selectedOther ]
        |> Seq.distinctBy (fun item -> item.entityType.ToLowerInvariant(), item.id.ToLowerInvariant(), normalizePath item.file, item.line)
        |> Seq.sortBy (fun item -> item.domain, item.entityType, item.id, item.origin)
        |> Seq.toList

let private typeSummaries (definitions: DefinitionFact seq) =
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

let private definitionStacks (definitions: DefinitionFact seq) =
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

let private definitionStackCount (definitions: DefinitionFact seq) =
    definitions
    |> Seq.groupBy (fun definition -> definition.entityType.ToLowerInvariant(), definition.id.ToLowerInvariant())
    |> Seq.filter (fun (_, values) -> values |> Seq.length > 1)
    |> Seq.length

let private domainSummaries (options: ExportOptions) (definitions: DefinitionFact seq) =
    definitions
    |> Seq.groupBy (fun definition -> definition.domain)
    |> Seq.map (fun (domain, values) ->
        let items = values |> Seq.toList
        let workspace = items |> List.filter (fun item -> item.origin = "workspace")
        let vanilla = items |> List.filter (fun item -> item.origin = "vanilla")
        let diverseExamples limit (source: DefinitionFact seq) =
            source
            |> Seq.groupBy (fun item -> item.entityType)
            |> Seq.collect (fun (_, group) -> group |> Seq.truncate 2)
            |> Seq.truncate limit
            |> Seq.toList
        let directories = items |> Seq.map (fun item -> normalizePath item.logicalPath |> Path.GetDirectoryName |> normalizePath) |> Seq.filter (String.IsNullOrWhiteSpace >> not) |> Seq.distinct |> Seq.truncate 20
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

let private compactDomainSummaries (definitions: DefinitionFact seq) =
    definitions
    |> Seq.groupBy (fun definition -> definition.domain)
    |> Seq.map (fun (domain, values) ->
        let items = values |> Seq.toList
        jsonRecord
            [ Some("id", JsonValue.String domain)
              Some("definitionCount", JsonValue.Number(decimal items.Length))
              Some("workspaceCount", JsonValue.Number(decimal (items |> List.filter (fun item -> item.origin = "workspace") |> List.length)))
              Some("vanillaCount", JsonValue.Number(decimal (items |> List.filter (fun item -> item.origin = "vanilla") |> List.length)))
              Some("entityTypes", items |> Seq.map (fun item -> item.entityType) |> Seq.distinct |> Seq.sort |> jsonStringArray |> Some |> Option.get) ])
    |> Seq.sortBy (fun value -> value.GetProperty("id").AsString())
    |> Seq.toArray

let private collectTopology (projectRoots: string list) (options: ExportOptions) (game: IGame<'T>) : TopologyFacts =
    let files = ResizeArray<FileFact>()
    let edges = ResizeArray<ReferenceFact>()
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
                                        { sourceFile = normalizePath entity.filepath
                                          sourceLogicalPath = normalizePath entity.logicalpath
                                          targetId = target
                                          typeGroup = typeGroup
                                          line = int reference.position.StartLine
                                          isOutgoing = reference.isOutgoing
                                          referenceType = reference.referenceType.ToString()
                                          label = reference.referenceLabel
                                          associatedType = reference.associatedType
                                          domain = domain })
                                target))
                        |> Seq.filter (String.IsNullOrWhiteSpace >> not)
                        |> Seq.distinct
                        |> Seq.truncate 100
                        |> Seq.toArray)
                    |> Option.defaultValue [||]
                files.Add(
                    { file = normalizePath entity.filepath
                      logicalPath = normalizePath entity.logicalpath
                      domain = domain
                      origin = originForPath projectRoots entity.filepath })
                ignore references

    { files = files |> Seq.distinctBy (fun item -> normalizePath item.file) |> Seq.toList
      edges =
        edges
        |> Seq.distinctBy (fun item -> normalizePath item.sourceFile, item.targetId, item.typeGroup, item.line, item.referenceType)
        |> Seq.toList
      truncated = fileCount >= options.maxTopologyFiles || edges.Count >= options.maxEdges }

let private topologyJson (topology: TopologyFacts) =
    jsonRecord
        [ Some("files", JsonValue.Array(
            topology.files
            |> List.map (fun item ->
                jsonRecord
                    [ Some("file", JsonValue.String item.file)
                      Some("logicalPath", JsonValue.String item.logicalPath)
                      Some("domain", JsonValue.String item.domain)
                      Some("origin", JsonValue.String item.origin) ])
            |> List.toArray))
          Some("edges", JsonValue.Array(
            topology.edges
            |> List.map (fun item ->
                jsonRecord
                    [ Some("sourceFile", JsonValue.String item.sourceFile)
                      Some("sourceLogicalPath", JsonValue.String item.sourceLogicalPath)
                      Some("targetId", JsonValue.String item.targetId)
                      Some("typeGroup", JsonValue.String item.typeGroup)
                      Some("line", JsonValue.Number(decimal item.line))
                      Some("isOutgoing", JsonValue.Boolean item.isOutgoing)
                      Some("referenceType", JsonValue.String item.referenceType)
                      item.label |> Option.map (fun value -> "label", JsonValue.String value)
                      item.associatedType |> Option.map (fun value -> "associatedType", JsonValue.String value)
                      Some("domain", JsonValue.String item.domain) ])
            |> List.toArray))
          Some("truncated", JsonValue.Boolean topology.truncated) ]

let private regexOptions = RegexOptions.Compiled ||| RegexOptions.IgnoreCase ||| RegexOptions.Multiline

let private eventCallRegex =
    Regex(@"\b(country_event|planet_event|fleet_event|ship_event|pop_event|pop_faction_event|observer_event|situation_event|first_contact_event|espionage_operation_event|astral_rift_event|event)\s*=\s*(?:\{\s*id\s*=\s*)?([A-Za-z0-9_.-]+)", regexOptions)

let private eventTitleRegex = Regex(@"\btitle\s*=\s*""?([A-Za-z0-9_.-]+)""?", regexOptions)
let private triggeredOnlyRegex = Regex(@"\bis_triggered_only\s*=\s*yes\b", regexOptions)
let private hiddenEventRegex = Regex(@"\b(?:hide_window|is_hidden)\s*=\s*yes\b", regexOptions)
let private meanTimeToHappenRegex = Regex(@"\bmean_time_to_happen\s*=\s*\{", regexOptions)
let private fireOnActionRegex = Regex(@"\bfire_on_action\s*=\s*""?([A-Za-z0-9_.-]+)""?", regexOptions)

let private eventPhaseRegexes =
    [ "trigger", Regex(@"\btrigger\s*=\s*\{", regexOptions)
      "immediate", Regex(@"\bimmediate\s*=\s*\{", regexOptions)
      "option", Regex(@"\boption\s*=\s*\{", regexOptions)
      "after", Regex(@"\bafter\s*=\s*\{", regexOptions) ]

let private eventLogicRegexes =
    [ "flag_set", "auto", Regex(@"\bset_(country|planet|fleet|ship|pop|leader|global)_flag\s*=\s*""?([A-Za-z0-9_.-]+)""?", regexOptions)
      "flag_set", "auto", Regex(@"\bset_timed_(country|planet|fleet|ship|pop|leader|global)_flag\s*=\s*\{[^{}]*?\bflag\s*=\s*""?([A-Za-z0-9_.-]+)""?", regexOptions)
      "flag_check", "trigger", Regex(@"\bhas_(country|planet|fleet|ship|pop|leader|global)_flag\s*=\s*""?([A-Za-z0-9_.-]+)""?", regexOptions)
      "flag_remove", "auto", Regex(@"\bremove_(country|planet|fleet|ship|pop|leader|global)_flag\s*=\s*""?([A-Za-z0-9_.-]+)""?", regexOptions)
      "technology_grant", "auto", Regex(@"\b(?:give_technology|add_research_option)\s*=\s*(?:\{[^{}]*?\btech\s*=\s*)?""?([A-Za-z0-9_.-]+)""?", regexOptions)
      "technology_require", "trigger", Regex(@"\bhas_technology\s*=\s*""?([A-Za-z0-9_.-]+)""?", regexOptions)
      "variable_write", "auto", Regex(@"\b(?:set_variable|change_variable|subtract_variable|multiply_variable|divide_variable)\s*=\s*\{[^{}]*?\bwhich\s*=\s*""?([A-Za-z0-9_.-]+)""?", regexOptions)
      "variable_read", "trigger", Regex(@"\b(?:check_variable|is_variable_set|has_variable)\s*=\s*(?:\{[^{}]*?\bwhich\s*=\s*)?""?([A-Za-z0-9_.-]+)""?", regexOptions) ]

let private firstMatch (pattern: Regex) (text: string) =
    let matched = pattern.Match text
    if matched.Success && matched.Groups.Count > 1 then Some matched.Groups.[1].Value else None

let private hasMatch (pattern: Regex) (text: string) = pattern.IsMatch text

let private lineAtOffset startLine (text: string) offset =
    startLine + (text.AsSpan(0, min offset text.Length).Count('\n'))

let private readDefinitionText (cache: Dictionary<string, string array>) (definition: DefinitionFact) =
    try
        let lines =
            match cache.TryGetValue definition.file with
            | true, cached -> cached
            | false, _ ->
                let loaded = File.ReadAllLines definition.file
                if cache.Count >= 512 then cache.Clear()
                cache.[definition.file] <- loaded
                loaded
        let startIndex = max 0 (definition.line - 1)
        let endIndex = min (lines.Length - 1) (max startIndex (definition.endLine - 1))
        if lines.Length = 0 || startIndex >= lines.Length then ""
        else String.Join("\n", lines.[startIndex..endIndex])
    with _ -> ""

let private eventPhaseAt (text: string) offset =
    let start = max 0 (offset - 1200)
    let prefix = text.Substring(start, offset - start)
    let lastIndex (pattern: Regex) =
        pattern.Matches(prefix)
        |> Seq.cast<Match>
        |> Seq.tryLast
        |> Option.map (fun matched -> matched.Index)
        |> Option.defaultValue -1
    eventPhaseRegexes
    |> List.map (fun (phase, pattern) -> phase, lastIndex pattern)
    |> List.maxBy snd
    |> fun (phase, index) -> if index >= 0 then phase else "body"

let private collectPatternLogic (eventId: string) (sourceFile: string) (startLine: int) (relationType: string) (phase: string) (pattern: Regex) (text: string) : EventLogicFact list =
    pattern.Matches(text)
    |> Seq.cast<Match>
    |> Seq.choose (fun matched ->
        if matched.Groups.Count < 2 then None
        else
            let scope = if matched.Groups.Count > 2 && matched.Groups.[1].Success then Some matched.Groups.[1].Value else None
            let subjectGroup = if matched.Groups.Count > 2 then matched.Groups.[2] else matched.Groups.[1]
            if not subjectGroup.Success || String.IsNullOrWhiteSpace subjectGroup.Value then None
            else
                Some
                    { eventId = eventId
                      relationType = relationType
                      subject = subjectGroup.Value
                      scope = scope
                      phase = if phase = "auto" then eventPhaseAt text matched.Index else phase
                      sourceFile = normalizePath sourceFile
                      line = lineAtOffset startLine text matched.Index
                      details = None })
    |> Seq.toList

let private collectEventGraph (definitions: DefinitionFact list) (topology: TopologyFacts) : EventGraphFacts =
    let textCache = Dictionary<string, string array>(if OperatingSystem.IsWindows() then StringComparer.OrdinalIgnoreCase else StringComparer.Ordinal)
    let pathComparer = if OperatingSystem.IsWindows() then StringComparer.OrdinalIgnoreCase else StringComparer.Ordinal
    let eventDefinitions =
        definitions
        |> List.filter (fun definition -> definition.domain = "events" && definition.id.Contains('.'))
        |> List.distinctBy (fun definition -> normalizePath definition.file, definition.line, definition.id)
        |> List.sortBy (fun definition -> normalizePath definition.file, definition.line, definition.id)
    let eventIds = eventDefinitions |> Seq.map (fun item -> item.id.ToLowerInvariant()) |> Set.ofSeq
    let nodes = ResizeArray<EventNodeFact>()
    let edges = ResizeArray<EventEdgeFact>()
    let logic = ResizeArray<EventLogicFact>()

    for definition in eventDefinitions do
        let text = readDefinitionText textCache definition
        if not (String.IsNullOrWhiteSpace text) then
            let eventType = definition.subtypes |> List.tryHead |> Option.defaultValue definition.entityType
            nodes.Add
                { eventId = definition.id
                  eventType = eventType
                  title = firstMatch eventTitleRegex text
                  file = normalizePath definition.file
                  logicalPath = normalizePath definition.logicalPath
                  line = definition.line
                  endLine = definition.endLine
                  origin = definition.origin
                  isTriggeredOnly = hasMatch triggeredOnlyRegex text
                  isHidden = hasMatch hiddenEventRegex text
                  hasMeanTimeToHappen = hasMatch meanTimeToHappenRegex text }

            for matched in eventCallRegex.Matches(text) |> Seq.cast<Match> do
                let target = matched.Groups.[2].Value
                if not (String.IsNullOrWhiteSpace target) && not (target.Equals(definition.id, StringComparison.OrdinalIgnoreCase)) then
                    edges.Add
                        { sourceKind = "event"
                          sourceId = definition.id
                          targetEventId = target
                          edgeType = eventPhaseAt text matched.Index
                          label = None
                          sourceFile = normalizePath definition.file
                          line = lineAtOffset definition.line text matched.Index
                          confidence = "parsed" }

            for matched in fireOnActionRegex.Matches(text) |> Seq.cast<Match> do
                logic.Add
                    { eventId = definition.id
                      relationType = "fire_on_action"
                      subject = matched.Groups.[1].Value
                      scope = None
                      phase = eventPhaseAt text matched.Index
                      sourceFile = normalizePath definition.file
                      line = lineAtOffset definition.line text matched.Index
                      details = None }

            eventLogicRegexes
            |> List.collect (fun (relationType, phase, pattern) ->
                collectPatternLogic definition.id definition.file definition.line relationType phase pattern text)
            |> logic.AddRange

    let nodeByFile = Dictionary<string, EventNodeFact list>(pathComparer)
    for file, values in nodes |> Seq.groupBy (fun node -> normalizePath node.file) do
        nodeByFile.[file] <- values |> Seq.toList

    // Topology edges frequently originate outside event blocks (especially from
    // on_actions). Index definitions once instead of scanning the complete game
    // model for every incoming event reference.
    let definitionsByFile = Dictionary<string, DefinitionFact list>(pathComparer)
    for file, values in definitions |> Seq.groupBy (fun definition -> normalizePath definition.file) do
        definitionsByFile.[file] <- values |> Seq.toList

    for reference in topology.edges do
        if eventIds.Contains(reference.targetId.ToLowerInvariant()) then
            let sourceNode =
                match nodeByFile.TryGetValue(normalizePath reference.sourceFile) with
                | true, candidates -> candidates |> List.tryFind (fun node -> reference.line >= node.line && reference.line <= node.endLine)
                | false, _ -> None
            match sourceNode with
            | Some node ->
                edges.Add
                    { sourceKind = "event"
                      sourceId = node.eventId
                      targetEventId = reference.targetId
                      edgeType = "typed_reference"
                      label = reference.label
                      sourceFile = reference.sourceFile
                      line = reference.line
                      confidence = "lsp" }
                reference.associatedType
                |> Option.iter (fun scope ->
                    logic.Add
                        { eventId = node.eventId
                          relationType = "scope_bridge"
                          subject = reference.targetId
                          scope = Some scope
                          phase = "reference"
                          sourceFile = reference.sourceFile
                          line = reference.line
                          details = Some reference.typeGroup })
            | None ->
                let sourceDefinition =
                    match definitionsByFile.TryGetValue(normalizePath reference.sourceFile) with
                    | true, candidates ->
                        candidates
                        |> List.tryFind (fun definition ->
                            reference.line >= definition.line
                            && reference.line <= definition.endLine)
                    | false, _ -> None
                sourceDefinition
                |> Option.iter (fun definition ->
                    edges.Add
                        { sourceKind = definition.entityType
                          sourceId = definition.id
                          targetEventId = reference.targetId
                          edgeType = if definition.domain = "on_actions" then "on_action_entry" else "typed_entry"
                          label = reference.label
                          sourceFile = reference.sourceFile
                          line = reference.line
                          confidence = "lsp" })

    { nodes = nodes |> Seq.distinctBy (fun item -> item.eventId, item.file, item.line) |> Seq.toList
      edges = edges |> Seq.distinctBy (fun item -> item.sourceKind, item.sourceId, item.targetEventId, item.edgeType, item.line) |> Seq.truncate 30000 |> Seq.toList
      logic = logic |> Seq.distinctBy (fun item -> item.eventId, item.relationType, item.subject, item.scope, item.line) |> Seq.truncate 30000 |> Seq.toList }

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

let private executeSql (connection: SqliteConnection) (transaction: SqliteTransaction option) sql =
    use command = connection.CreateCommand()
    command.CommandText <- sql
    transaction |> Option.iter (fun value -> command.Transaction <- value)
    command.ExecuteNonQuery() |> ignore

let private addParameter (command: SqliteCommand) name (value: obj) =
    command.Parameters.AddWithValue(name, if isNull value then DBNull.Value :> obj else value) |> ignore

let private createKnowledgeSchema connection =
    executeSql connection None """
PRAGMA foreign_keys = ON;
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  definition_count INTEGER NOT NULL,
  workspace_count INTEGER NOT NULL,
  vanilla_count INTEGER NOT NULL,
  entity_types_json TEXT NOT NULL,
  directories_json TEXT NOT NULL
);
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  logical_path TEXT NOT NULL,
  domain TEXT NOT NULL,
  origin TEXT NOT NULL
);
CREATE TABLE definitions (
  id INTEGER PRIMARY KEY,
  symbol_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  logical_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  origin TEXT NOT NULL,
  validate INTEGER NOT NULL,
  overwrite_state TEXT NOT NULL,
  resource_scope TEXT,
  domain TEXT NOT NULL,
  override_path TEXT,
  override_strategy TEXT
);
CREATE TABLE definition_subtypes (
  definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  subtype TEXT NOT NULL,
  PRIMARY KEY(definition_id, subtype)
);
CREATE TABLE definition_stacks (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  resolution TEXT NOT NULL,
  UNIQUE(entity_type, symbol_id)
);
CREATE TABLE stack_candidates (
  stack_id INTEGER NOT NULL REFERENCES definition_stacks(id) ON DELETE CASCADE,
  definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL,
  PRIMARY KEY(stack_id, definition_id)
);
CREATE TABLE references_graph (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_logical_path TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type_group TEXT NOT NULL,
  line INTEGER NOT NULL,
  is_outgoing INTEGER NOT NULL,
  reference_type TEXT NOT NULL,
  label TEXT,
  associated_type TEXT,
  domain TEXT NOT NULL
);
CREATE TABLE archetypes (
  definition_id INTEGER NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  origin TEXT NOT NULL,
  rank INTEGER NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY(definition_id, role)
);
CREATE TABLE override_modes (path TEXT PRIMARY KEY, strategy TEXT NOT NULL);
CREATE TABLE override_mode_info (id TEXT PRIMARY KEY, name TEXT, description TEXT);
CREATE TABLE unresolved (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_type TEXT,
  symbol_id TEXT,
  resolution TEXT,
  message TEXT NOT NULL
);
CREATE TABLE event_nodes (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT,
  file_path TEXT NOT NULL,
  logical_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  origin TEXT NOT NULL,
  is_triggered_only INTEGER NOT NULL,
  is_hidden INTEGER NOT NULL,
  has_mtth INTEGER NOT NULL
);
CREATE TABLE event_edges (
  id INTEGER PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_event_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  label TEXT,
  source_file TEXT NOT NULL,
  line INTEGER NOT NULL,
  confidence TEXT NOT NULL
);
CREATE TABLE event_logic (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  scope TEXT,
  phase TEXT NOT NULL,
  source_file TEXT NOT NULL,
  line INTEGER NOT NULL,
  details TEXT
);
"""

let private createKnowledgeIndexes connection transaction =
    executeSql connection (Some transaction) """
CREATE INDEX idx_definitions_symbol ON definitions(symbol_id COLLATE NOCASE);
CREATE INDEX idx_definitions_type ON definitions(entity_type COLLATE NOCASE);
CREATE INDEX idx_definitions_domain_origin ON definitions(domain, origin);
CREATE INDEX idx_definitions_file ON definitions(file_path, line);
CREATE INDEX idx_references_target ON references_graph(target_id COLLATE NOCASE);
CREATE INDEX idx_references_source ON references_graph(source_file, line);
CREATE INDEX idx_event_nodes_id ON event_nodes(event_id COLLATE NOCASE);
CREATE INDEX idx_event_edges_source ON event_edges(source_id COLLATE NOCASE);
CREATE INDEX idx_event_edges_target ON event_edges(target_event_id COLLATE NOCASE);
CREATE INDEX idx_event_logic_event ON event_logic(event_id COLLATE NOCASE);
CREATE INDEX idx_event_logic_subject ON event_logic(subject COLLATE NOCASE);
"""

let private setCommandParameters (command: SqliteCommand) values =
    command.Parameters.Clear()
    values |> List.iter (fun (name, value) -> addParameter command name value)

let private prepareCommandParameters (command: SqliteCommand) (values: (string * obj) list) =
    setCommandParameters command values
    command.Prepare()

let private setPreparedCommandParameters (command: SqliteCommand) (values: (string * obj) list) =
    values
    |> List.iter (fun (name, value) ->
        command.Parameters.[name].Value <- if isNull value then DBNull.Value :> obj else value)

let private writeKnowledgeDatabase (databasePath: string) (activeGame: string) (projectRoots: string list) (options: ExportOptions) (runtime: RuntimeMetadata) (definitions: DefinitionFact list) (topology: TopologyFacts) (eventGraph: EventGraphFacts) (game: IGame) (warnings: seq<string>) =
    let target = Path.GetFullPath databasePath
    let allowed = projectRoots |> List.exists (fun root -> pathInside root target)
    if not allowed then invalidArg "databasePath" "Project knowledge database must be inside a project root."
    Directory.CreateDirectory(Path.GetDirectoryName target) |> ignore
    let temporary = target + ".tmp-" + Guid.NewGuid().ToString("N")
    if File.Exists temporary then File.Delete temporary
    use temporaryCleanup =
        { new IDisposable with
            member _.Dispose() =
                try
                    if File.Exists temporary then File.Delete temporary
                with _ -> () }
    let mutable publishDatabase = false
    use atomicPublisher =
        { new IDisposable with
            member _.Dispose() =
                if publishDatabase then File.Move(temporary, target, true) }
    let connectionString = SqliteConnectionStringBuilder(DataSource = temporary, Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false).ToString()
    use connection = new SqliteConnection(connectionString)
    connection.Open()
    executeSql connection None "PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;"
    createKnowledgeSchema connection
    use transaction = connection.BeginTransaction()

    let insertMetadata key value =
        use command = connection.CreateCommand()
        command.Transaction <- transaction
        command.CommandText <- "INSERT INTO metadata(key, value) VALUES ($key, $value)"
        addParameter command "$key" key
        addParameter command "$value" value
        command.ExecuteNonQuery() |> ignore

    let generatedAt = DateTimeOffset.UtcNow
    insertMetadata "schema_version" "2"
    insertMetadata "status" runtime.status
    insertMetadata "game" activeGame
    insertMetadata "generated_at" (generatedAt.ToString("O"))
    insertMetadata "generated_at_unix_ms" (generatedAt.ToUnixTimeMilliseconds().ToString())
    insertMetadata "graph_version" (runtime.graphVersion.ToString())
    insertMetadata "project_roots" (JsonValue.Array(projectRoots |> List.map JsonValue.String |> List.toArray).ToString(JsonSaveOptions.DisableFormatting))
    insertMetadata "generation_mode" options.generationMode
    insertMetadata "validation_in_progress" ((string runtime.validationInProgress).ToLowerInvariant())
    insertMetadata "loading_in_progress" ((string runtime.loadingInProgress).ToLowerInvariant())
    insertMetadata "pending_global_kinds" (JsonValue.Array(runtime.pendingGlobalKinds |> List.map JsonValue.String |> List.toArray).ToString(JsonSaveOptions.DisableFormatting))
    insertMetadata "last_global_refresh_at_unix_ms" (runtime.lastGlobalRefreshAtUnixMs.ToString())
    insertMetadata "warnings" (JsonValue.Array(warnings |> Seq.map JsonValue.String |> Seq.toArray).ToString(JsonSaveOptions.DisableFormatting))

    use domainCommand = connection.CreateCommand()
    domainCommand.Transaction <- transaction
    domainCommand.CommandText <- "INSERT INTO domains(id, definition_count, workspace_count, vanilla_count, entity_types_json, directories_json) VALUES ($id, $count, $workspace, $vanilla, $types, $directories)"
    let allDomains =
        Seq.append (definitions |> Seq.map (fun item -> item.domain)) (topology.files |> Seq.map (fun item -> item.domain))
        |> Seq.distinct
        |> Seq.sort
        |> Seq.toList
    for domain in allDomains do
        let items = definitions |> List.filter (fun item -> item.domain = domain)
        let types = items |> Seq.map (fun item -> item.entityType) |> Seq.distinct |> Seq.sort |> Seq.map JsonValue.String |> Seq.toArray |> JsonValue.Array
        let directories = items |> Seq.map (fun item -> normalizePath item.logicalPath |> Path.GetDirectoryName |> normalizePath) |> Seq.filter (String.IsNullOrWhiteSpace >> not) |> Seq.distinct |> Seq.sort |> Seq.map JsonValue.String |> Seq.toArray |> JsonValue.Array
        setCommandParameters domainCommand
            [ "$id", box domain
              "$count", box items.Length
              "$workspace", box (items |> List.filter (fun item -> item.origin = "workspace") |> List.length)
              "$vanilla", box (items |> List.filter (fun item -> item.origin = "vanilla") |> List.length)
              "$types", box (types.ToString(JsonSaveOptions.DisableFormatting))
              "$directories", box (directories.ToString(JsonSaveOptions.DisableFormatting)) ]
        domainCommand.ExecuteNonQuery() |> ignore

    use fileCommand = connection.CreateCommand()
    fileCommand.Transaction <- transaction
    fileCommand.CommandText <- "INSERT OR IGNORE INTO files(path, logical_path, domain, origin) VALUES ($path, $logical, $domain, $origin)"
    for item in topology.files do
        setCommandParameters fileCommand [ "$path", box item.file; "$logical", box item.logicalPath; "$domain", box item.domain; "$origin", box item.origin ]
        fileCommand.ExecuteNonQuery() |> ignore

    use definitionCommand = connection.CreateCommand()
    definitionCommand.Transaction <- transaction
    definitionCommand.CommandText <- "INSERT INTO definitions(symbol_id, entity_type, file_path, logical_path, line, end_line, origin, validate, overwrite_state, resource_scope, domain, override_path, override_strategy) VALUES ($symbol, $type, $file, $logical, $line, $end, $origin, $validate, $overwrite, $scope, $domain, $overridePath, $overrideStrategy) RETURNING id"
    prepareCommandParameters definitionCommand
        [ "$symbol", box ""; "$type", box ""; "$file", box ""; "$logical", box ""; "$line", box 0; "$end", box 0
          "$origin", box ""; "$validate", box 0; "$overwrite", box ""; "$scope", box ""; "$domain", box ""
          "$overridePath", box ""; "$overrideStrategy", box "" ]
    use subtypeCommand = connection.CreateCommand()
    subtypeCommand.Transaction <- transaction
    subtypeCommand.CommandText <- "INSERT OR IGNORE INTO definition_subtypes(definition_id, subtype) VALUES ($definition, $subtype)"
    prepareCommandParameters subtypeCommand [ "$definition", box 0L; "$subtype", box "" ]
    let definitionIds = Dictionary<string, int64>(StringComparer.OrdinalIgnoreCase)
    let definitionKey definition = String.Join("|", [| definition.entityType; definition.id; normalizePath definition.file; string definition.line |])
    for definition in definitions do
        setPreparedCommandParameters definitionCommand
            [ "$symbol", box definition.id; "$type", box definition.entityType; "$file", box (normalizePath definition.file)
              "$logical", box (normalizePath definition.logicalPath); "$line", box definition.line; "$end", box definition.endLine
              "$origin", box definition.origin; "$validate", box (if definition.validate then 1 else 0); "$overwrite", box definition.overwrite
              "$scope", box (definition.resourceScope |> Option.toObj); "$domain", box definition.domain
              "$overridePath", box (definition.overridePath |> Option.toObj); "$overrideStrategy", box (definition.overrideStrategy |> Option.toObj) ]
        let definitionId = definitionCommand.ExecuteScalar() :?> int64
        definitionIds.[definitionKey definition] <- definitionId
        for subtype in definition.subtypes do
            setPreparedCommandParameters subtypeCommand [ "$definition", box definitionId; "$subtype", box subtype ]
            subtypeCommand.ExecuteNonQuery() |> ignore

    use stackCommand = connection.CreateCommand()
    stackCommand.Transaction <- transaction
    stackCommand.CommandText <- "INSERT INTO definition_stacks(entity_type, symbol_id, resolution) VALUES ($type, $symbol, $resolution) RETURNING id"
    use candidateCommand = connection.CreateCommand()
    candidateCommand.Transaction <- transaction
    candidateCommand.CommandText <- "INSERT OR IGNORE INTO stack_candidates(stack_id, definition_id, is_active) VALUES ($stack, $definition, $active)"
    use unresolvedCommand = connection.CreateCommand()
    unresolvedCommand.Transaction <- transaction
    unresolvedCommand.CommandText <- "INSERT INTO unresolved(kind, entity_type, symbol_id, resolution, message) VALUES ($kind, $type, $symbol, $resolution, $message)"
    for ((_typeKey, _idKey), values) in definitions |> Seq.groupBy (fun item -> item.entityType.ToLowerInvariant(), item.id.ToLowerInvariant()) do
        let items = values |> Seq.toList
        if items.Length > 1 then
            let active = items |> List.filter (fun item -> item.overwrite <> "overwritten")
            let resolution = if active.Length = 1 then "single_active_definition" elif items |> List.exists (fun item -> item.overrideStrategy.IsSome) then "consult_override_mode" else "ambiguous"
            setCommandParameters stackCommand [ "$type", box items.Head.entityType; "$symbol", box items.Head.id; "$resolution", box resolution ]
            let stackId = stackCommand.ExecuteScalar() :?> int64
            for definition in items do
                match definitionIds.TryGetValue(definitionKey definition) with
                | true, definitionId ->
                    setCommandParameters candidateCommand [ "$stack", box stackId; "$definition", box definitionId; "$active", box (if definition.overwrite <> "overwritten" then 1 else 0) ]
                    candidateCommand.ExecuteNonQuery() |> ignore
                | _ -> ()
            if resolution = "ambiguous" || resolution = "consult_override_mode" then
                setCommandParameters unresolvedCommand
                    [ "$kind", box "definition_resolution"; "$type", box items.Head.entityType; "$symbol", box items.Head.id; "$resolution", box resolution
                      "$message", box "The effective definition requires override-mode or ambiguity review." ]
                unresolvedCommand.ExecuteNonQuery() |> ignore

    use archetypeCommand = connection.CreateCommand()
    archetypeCommand.Transaction <- transaction
    archetypeCommand.CommandText <- "INSERT OR IGNORE INTO archetypes(definition_id, domain, origin, rank, role) VALUES ($definition, $domain, $origin, $rank, $role)"
    for domain in allDomains do
        let addArchetypes role origin limit =
            definitions
            |> Seq.filter (fun item -> item.domain = domain && item.origin = origin)
            |> Seq.groupBy (fun item -> item.entityType)
            |> Seq.collect (fun (_, group) -> group |> Seq.truncate 2)
            |> Seq.truncate limit
            |> Seq.iteri (fun rank definition ->
                match definitionIds.TryGetValue(definitionKey definition) with
                | true, definitionId ->
                    setCommandParameters archetypeCommand [ "$definition", box definitionId; "$domain", box domain; "$origin", box origin; "$rank", box rank; "$role", box role ]
                    archetypeCommand.ExecuteNonQuery() |> ignore
                | _ -> ())
        addArchetypes "project_pattern" "workspace" 12
        addArchetypes "vanilla_archetype" "vanilla" options.archetypesPerDomain

    use referenceCommand = connection.CreateCommand()
    referenceCommand.Transaction <- transaction
    referenceCommand.CommandText <- "INSERT INTO references_graph(source_file, source_logical_path, target_id, type_group, line, is_outgoing, reference_type, label, associated_type, domain) VALUES ($file, $logical, $target, $group, $line, $outgoing, $referenceType, $label, $associated, $domain)"
    prepareCommandParameters referenceCommand
        [ "$file", box ""; "$logical", box ""; "$target", box ""; "$group", box ""; "$line", box 0; "$outgoing", box 0
          "$referenceType", box ""; "$label", box ""; "$associated", box ""; "$domain", box "" ]
    for reference in topology.edges do
        setPreparedCommandParameters referenceCommand
            [ "$file", box reference.sourceFile; "$logical", box reference.sourceLogicalPath; "$target", box reference.targetId; "$group", box reference.typeGroup
              "$line", box reference.line; "$outgoing", box (if reference.isOutgoing then 1 else 0); "$referenceType", box reference.referenceType
              "$label", box (reference.label |> Option.toObj); "$associated", box (reference.associatedType |> Option.toObj); "$domain", box reference.domain ]
        referenceCommand.ExecuteNonQuery() |> ignore

    use overrideCommand = connection.CreateCommand()
    overrideCommand.Transaction <- transaction
    overrideCommand.CommandText <- "INSERT OR REPLACE INTO override_modes(path, strategy) VALUES ($path, $strategy)"
    for item in game.OverrideModes() do
        setCommandParameters overrideCommand [ "$path", box item.path; "$strategy", box item.strategy ]
        overrideCommand.ExecuteNonQuery() |> ignore
    use overrideInfoCommand = connection.CreateCommand()
    overrideInfoCommand.Transaction <- transaction
    overrideInfoCommand.CommandText <- "INSERT OR REPLACE INTO override_mode_info(id, name, description) VALUES ($id, $name, $description)"
    for item in game.OverrideModesInfo() do
        setCommandParameters overrideInfoCommand [ "$id", box item.id; "$name", box (item.name |> Option.toObj); "$description", box (item.description |> Option.toObj) ]
        overrideInfoCommand.ExecuteNonQuery() |> ignore

    use eventNodeCommand = connection.CreateCommand()
    eventNodeCommand.Transaction <- transaction
    eventNodeCommand.CommandText <- "INSERT INTO event_nodes(event_id, event_type, title, file_path, logical_path, line, end_line, origin, is_triggered_only, is_hidden, has_mtth) VALUES ($id, $type, $title, $file, $logical, $line, $end, $origin, $triggered, $hidden, $mtth)"
    prepareCommandParameters eventNodeCommand
        [ "$id", box ""; "$type", box ""; "$title", box ""; "$file", box ""; "$logical", box ""; "$line", box 0
          "$end", box 0; "$origin", box ""; "$triggered", box 0; "$hidden", box 0; "$mtth", box 0 ]
    for node in eventGraph.nodes do
        setPreparedCommandParameters eventNodeCommand
            [ "$id", box node.eventId; "$type", box node.eventType; "$title", box (node.title |> Option.toObj); "$file", box node.file
              "$logical", box node.logicalPath; "$line", box node.line; "$end", box node.endLine; "$origin", box node.origin
              "$triggered", box (if node.isTriggeredOnly then 1 else 0); "$hidden", box (if node.isHidden then 1 else 0); "$mtth", box (if node.hasMeanTimeToHappen then 1 else 0) ]
        eventNodeCommand.ExecuteNonQuery() |> ignore
    use eventEdgeCommand = connection.CreateCommand()
    eventEdgeCommand.Transaction <- transaction
    eventEdgeCommand.CommandText <- "INSERT INTO event_edges(source_kind, source_id, target_event_id, edge_type, label, source_file, line, confidence) VALUES ($kind, $source, $target, $type, $label, $file, $line, $confidence)"
    prepareCommandParameters eventEdgeCommand
        [ "$kind", box ""; "$source", box ""; "$target", box ""; "$type", box ""; "$label", box ""; "$file", box ""
          "$line", box 0; "$confidence", box "" ]
    for edge in eventGraph.edges do
        setPreparedCommandParameters eventEdgeCommand
            [ "$kind", box edge.sourceKind; "$source", box edge.sourceId; "$target", box edge.targetEventId; "$type", box edge.edgeType
              "$label", box (edge.label |> Option.toObj); "$file", box edge.sourceFile; "$line", box edge.line; "$confidence", box edge.confidence ]
        eventEdgeCommand.ExecuteNonQuery() |> ignore
    use eventLogicCommand = connection.CreateCommand()
    eventLogicCommand.Transaction <- transaction
    eventLogicCommand.CommandText <- "INSERT INTO event_logic(event_id, relation_type, subject, scope, phase, source_file, line, details) VALUES ($event, $type, $subject, $scope, $phase, $file, $line, $details)"
    prepareCommandParameters eventLogicCommand
        [ "$event", box ""; "$type", box ""; "$subject", box ""; "$scope", box ""; "$phase", box ""; "$file", box ""
          "$line", box 0; "$details", box "" ]
    for item in eventGraph.logic do
        setPreparedCommandParameters eventLogicCommand
            [ "$event", box item.eventId; "$type", box item.relationType; "$subject", box item.subject; "$scope", box (item.scope |> Option.toObj)
              "$phase", box item.phase; "$file", box item.sourceFile; "$line", box item.line; "$details", box (item.details |> Option.toObj) ]
        eventLogicCommand.ExecuteNonQuery() |> ignore

    createKnowledgeIndexes connection transaction
    transaction.Commit()
    publishDatabase <- true
    target, generatedAt

let private readMetadata (connection: SqliteConnection) =
    use command = connection.CreateCommand()
    command.CommandText <- "SELECT key, value FROM metadata"
    use reader = command.ExecuteReader()
    let values = Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    while reader.Read() do values.[reader.GetString(0)] <- reader.GetString(1)
    values

let private stringOrNone (reader: SqliteDataReader) index =
    if reader.IsDBNull index then None else Some(reader.GetString index)

let private readRetainedKnowledgeDatabase (databasePath: string) (excludedDomains: string list) =
    if not (File.Exists databasePath) then None
    else
        try
            let excluded = excludedDomains |> Seq.map (fun value -> value.ToLowerInvariant()) |> Set.ofSeq
            let connectionString = SqliteConnectionStringBuilder(DataSource = databasePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false).ToString()
            use connection = new SqliteConnection(connectionString)
            connection.Open()

            let subtypes = Dictionary<int64, ResizeArray<string>>()
            use subtypeCommand = connection.CreateCommand()
            subtypeCommand.CommandText <- "SELECT definition_id, subtype FROM definition_subtypes ORDER BY definition_id, subtype"
            use subtypeReader = subtypeCommand.ExecuteReader()
            while subtypeReader.Read() do
                let definitionId = subtypeReader.GetInt64 0
                let values =
                    match subtypes.TryGetValue definitionId with
                    | true, existing -> existing
                    | _ ->
                        let created = ResizeArray<string>()
                        subtypes.[definitionId] <- created
                        created
                values.Add(subtypeReader.GetString 1)

            let definitions = ResizeArray<DefinitionFact>()
            use definitionCommand = connection.CreateCommand()
            definitionCommand.CommandText <- "SELECT id, symbol_id, entity_type, file_path, logical_path, line, end_line, origin, validate, overwrite_state, resource_scope, domain, override_path, override_strategy FROM definitions"
            use definitionReader = definitionCommand.ExecuteReader()
            while definitionReader.Read() do
                let domain = definitionReader.GetString 11
                if not (excluded.Contains(domain.ToLowerInvariant())) then
                    let definitionId = definitionReader.GetInt64 0
                    let definitionSubtypes =
                        match subtypes.TryGetValue definitionId with
                        | true, values -> values |> Seq.toList
                        | _ -> []
                    definitions.Add
                        { id = definitionReader.GetString 1
                          entityType = definitionReader.GetString 2
                          file = definitionReader.GetString 3
                          logicalPath = definitionReader.GetString 4
                          line = int (definitionReader.GetInt64 5)
                          endLine = int (definitionReader.GetInt64 6)
                          origin = definitionReader.GetString 7
                          validate = definitionReader.GetInt64 8 <> 0L
                          subtypes = definitionSubtypes
                          overwrite = definitionReader.GetString 9
                          resourceScope = stringOrNone definitionReader 10
                          domain = domain
                          overridePath = stringOrNone definitionReader 12
                          overrideStrategy = stringOrNone definitionReader 13 }

            let files = ResizeArray<FileFact>()
            use fileCommand = connection.CreateCommand()
            fileCommand.CommandText <- "SELECT path, logical_path, domain, origin FROM files"
            use fileReader = fileCommand.ExecuteReader()
            while fileReader.Read() do
                let domain = fileReader.GetString 2
                if not (excluded.Contains(domain.ToLowerInvariant())) then
                    files.Add
                        { file = fileReader.GetString 0
                          logicalPath = fileReader.GetString 1
                          domain = domain
                          origin = fileReader.GetString 3 }

            let edges = ResizeArray<ReferenceFact>()
            use edgeCommand = connection.CreateCommand()
            edgeCommand.CommandText <- "SELECT source_file, source_logical_path, target_id, type_group, line, is_outgoing, reference_type, label, associated_type, domain FROM references_graph"
            use edgeReader = edgeCommand.ExecuteReader()
            while edgeReader.Read() do
                let domain = edgeReader.GetString 9
                if not (excluded.Contains(domain.ToLowerInvariant())) then
                    edges.Add
                        { sourceFile = edgeReader.GetString 0
                          sourceLogicalPath = edgeReader.GetString 1
                          targetId = edgeReader.GetString 2
                          typeGroup = edgeReader.GetString 3
                          line = int (edgeReader.GetInt64 4)
                          isOutgoing = edgeReader.GetInt64 5 <> 0L
                          referenceType = edgeReader.GetString 6
                          label = stringOrNone edgeReader 7
                          associatedType = stringOrNone edgeReader 8
                          domain = domain }

            Some(
                definitions |> Seq.toList,
                { files = files |> Seq.toList
                  edges = edges |> Seq.toList
                  truncated = false })
        with _ -> None

let private queryTokens (options: QueryOptions) =
    [ yield! options.intent |> Option.toList
      yield! options.identifiers
      yield! options.entityTypes ]
    |> String.concat " "
    |> fun value -> Regex.Matches(value.ToLowerInvariant(), @"[@a-z0-9_.:-]{2,}")
    |> Seq.cast<Match>
    |> Seq.map (fun matched -> matched.Value)
    |> Seq.distinct
    |> Seq.truncate 30
    |> Seq.toList

let private matchesTokens (tokens: string list) (values: string seq) =
    if tokens.IsEmpty then true
    else
        let text = String.Join(" ", values).ToLowerInvariant()
        tokens |> List.exists text.Contains

let private sqliteTokenClause (command: SqliteCommand) (tokens: string list) (columns: string list) =
    if tokens.IsEmpty then ""
    else
        tokens
        |> List.mapi (fun index token ->
            let parameter = "$queryToken" + string index
            addParameter command parameter (box token)
            columns
            |> List.map (fun column -> $"instr(lower(coalesce({column}, '')), {parameter}) > 0")
            |> String.concat " OR "
            |> fun clause -> "(" + clause + ")")
        |> String.concat " OR "
        |> fun clause -> " WHERE " + clause

let queryProjectKnowledgeDatabase (options: QueryOptions) =
    let databasePath = Path.GetFullPath options.databasePath
    if not (File.Exists databasePath) then
        jsonRecord
            [ Some("ok", JsonValue.Boolean false)
              Some("status", JsonValue.String "missing")
              Some("error", JsonValue.String "Project knowledge database is missing.")
              Some("databasePath", JsonValue.String(normalizePath databasePath)) ]
    else
        let connectionString = SqliteConnectionStringBuilder(DataSource = databasePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false).ToString()
        use connection = new SqliteConnection(connectionString)
        connection.Open()
        let metadata = readMetadata connection
        let getMetadata key fallback = match metadata.TryGetValue key with true, value -> value | _ -> fallback
        let limit = clamp 1 300 options.limit
        let tokens = queryTokens options
        let requestedDomains = options.domains |> List.map (fun item -> item.Trim().ToLowerInvariant()) |> List.filter (String.IsNullOrWhiteSpace >> not) |> List.distinct
        let allowedDomain (domain: string) = requestedDomains.IsEmpty || requestedDomains |> List.contains (domain.ToLowerInvariant())

        let capabilities = ResizeArray<JsonValue>()
        use domainCommand = connection.CreateCommand()
        domainCommand.CommandText <- "SELECT id, definition_count, workspace_count, vanilla_count, entity_types_json, directories_json FROM domains ORDER BY id"
        use domainReader = domainCommand.ExecuteReader()
        while domainReader.Read() do
            let domain = domainReader.GetString 0
            if allowedDomain domain then
                capabilities.Add(
                    jsonRecord
                        [ Some("domain", JsonValue.String domain)
                          Some("summary", jsonRecord
                            [ Some("id", JsonValue.String domain)
                              Some("definitionCount", JsonValue.Number(decimal (domainReader.GetInt64 1)))
                              Some("workspaceCount", JsonValue.Number(decimal (domainReader.GetInt64 2)))
                              Some("vanillaCount", JsonValue.Number(decimal (domainReader.GetInt64 3)))
                              Some("entityTypes", JsonValue.Parse(domainReader.GetString 4))
                              Some("directories", JsonValue.Parse(domainReader.GetString 5)) ]) ])

        let evidence = ResizeArray<JsonValue>()
        use definitionCommand = connection.CreateCommand()
        let definitionTokenClause = sqliteTokenClause definitionCommand tokens [ "symbol_id"; "entity_type"; "file_path"; "logical_path"; "domain" ]
        definitionCommand.CommandText <- "SELECT id, symbol_id, entity_type, file_path, logical_path, line, end_line, origin, validate, overwrite_state, resource_scope, domain, override_path, override_strategy FROM definitions" + definitionTokenClause + " ORDER BY CASE origin WHEN 'workspace' THEN 0 ELSE 1 END, symbol_id LIMIT $limit"
        addParameter definitionCommand "$limit" (box (max 500 (limit * 20)))
        use definitionReader = definitionCommand.ExecuteReader()
        while definitionReader.Read() && evidence.Count < limit do
            let symbolId = definitionReader.GetString 1
            let entityType = definitionReader.GetString 2
            let file = definitionReader.GetString 3
            let logicalPath = definitionReader.GetString 4
            let origin = definitionReader.GetString 7
            let domain = definitionReader.GetString 11
            let allowedOrigin =
                (origin = "workspace" && options.includeProjectPatterns)
                || (origin = "vanilla" && options.includeVanillaArchetypes)
            let allowedType = options.entityTypes.IsEmpty || options.entityTypes |> List.exists (fun item -> entityType.Contains(item, StringComparison.OrdinalIgnoreCase))
            if allowedDomain domain && allowedOrigin && allowedType && matchesTokens tokens [ symbolId; entityType; file; logicalPath; domain ] then
                evidence.Add(
                    jsonRecord
                        [ Some("kind", JsonValue.String "definition")
                          Some("id", JsonValue.String symbolId)
                          Some("entityType", JsonValue.String entityType)
                          Some("file", JsonValue.String file)
                          Some("logicalPath", JsonValue.String logicalPath)
                          Some("line", JsonValue.Number(decimal (definitionReader.GetInt64 5)))
                          Some("endLine", JsonValue.Number(decimal (definitionReader.GetInt64 6)))
                          Some("origin", JsonValue.String origin)
                          Some("validate", JsonValue.Boolean(definitionReader.GetInt64 8 <> 0L))
                          Some("overwrite", JsonValue.String(definitionReader.GetString 9))
                          stringOrNone definitionReader 10 |> Option.map (fun value -> "resourceScope", JsonValue.String value)
                          Some("domain", JsonValue.String domain)
                          stringOrNone definitionReader 12 |> Option.map (fun value -> "overridePath", JsonValue.String value)
                          stringOrNone definitionReader 13 |> Option.map (fun value -> "overrideStrategy", JsonValue.String value) ])
        definitionReader.Close()

        if options.includeTopology && evidence.Count < limit then
            use referenceCommand = connection.CreateCommand()
            let referenceTokenClause = sqliteTokenClause referenceCommand tokens [ "source_file"; "source_logical_path"; "target_id"; "type_group"; "label"; "associated_type"; "domain" ]
            referenceCommand.CommandText <- "SELECT source_file, source_logical_path, target_id, type_group, line, is_outgoing, reference_type, label, associated_type, domain FROM references_graph" + referenceTokenClause + " LIMIT $limit"
            addParameter referenceCommand "$limit" (box (max 500 (limit * 20)))
            use referenceReader = referenceCommand.ExecuteReader()
            while referenceReader.Read() && evidence.Count < limit do
                let sourceFile = referenceReader.GetString 0
                let sourceLogicalPath = referenceReader.GetString 1
                let targetId = referenceReader.GetString 2
                let typeGroup = referenceReader.GetString 3
                let domain = referenceReader.GetString 9
                if allowedDomain domain && matchesTokens tokens [ sourceFile; sourceLogicalPath; targetId; typeGroup; domain ] then
                    evidence.Add(
                        jsonRecord
                            [ Some("kind", JsonValue.String "reference")
                              Some("sourceFile", JsonValue.String sourceFile)
                              Some("sourceLogicalPath", JsonValue.String sourceLogicalPath)
                              Some("targetId", JsonValue.String targetId)
                              Some("typeGroup", JsonValue.String typeGroup)
                              Some("line", JsonValue.Number(decimal (referenceReader.GetInt64 4)))
                              Some("isOutgoing", JsonValue.Boolean(referenceReader.GetInt64 5 <> 0L))
                              Some("referenceType", JsonValue.String(referenceReader.GetString 6))
                              stringOrNone referenceReader 7 |> Option.map (fun value -> "label", JsonValue.String value)
                              stringOrNone referenceReader 8 |> Option.map (fun value -> "associatedType", JsonValue.String value)
                              Some("domain", JsonValue.String domain) ])
            referenceReader.Close()

        let eventNodes = ResizeArray<JsonValue>()
        let eventEdges = ResizeArray<JsonValue>()
        let eventLogic = ResizeArray<JsonValue>()
        let returnedNodeIds = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        let relatedEventIds = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        let logicSubjects = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        let returnedLogicKeys = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        if options.includeEventGraph then
            use nodeCommand = connection.CreateCommand()
            let nodeTokenClause = sqliteTokenClause nodeCommand tokens [ "event_id"; "event_type"; "title"; "file_path"; "logical_path" ]
            nodeCommand.CommandText <- "SELECT event_id, event_type, title, file_path, logical_path, line, end_line, origin, is_triggered_only, is_hidden, has_mtth FROM event_nodes" + nodeTokenClause + " LIMIT $limit"
            addParameter nodeCommand "$limit" (box (max 200 (limit * 10)))
            use nodeReader = nodeCommand.ExecuteReader()
            while nodeReader.Read() && eventNodes.Count < limit do
                let eventId = nodeReader.GetString 0
                let eventType = nodeReader.GetString 1
                let file = nodeReader.GetString 3
                if matchesTokens tokens [ eventId; eventType; file; stringOrNone nodeReader 2 |> Option.defaultValue "" ] then
                    returnedNodeIds.Add eventId |> ignore
                    eventNodes.Add(
                        jsonRecord
                            [ Some("eventId", JsonValue.String eventId); Some("eventType", JsonValue.String eventType)
                              stringOrNone nodeReader 2 |> Option.map (fun value -> "title", JsonValue.String value)
                              Some("file", JsonValue.String file); Some("logicalPath", JsonValue.String(nodeReader.GetString 4))
                              Some("line", JsonValue.Number(decimal (nodeReader.GetInt64 5))); Some("endLine", JsonValue.Number(decimal (nodeReader.GetInt64 6)))
                              Some("origin", JsonValue.String(nodeReader.GetString 7)); Some("isTriggeredOnly", JsonValue.Boolean(nodeReader.GetInt64 8 <> 0L))
                              Some("isHidden", JsonValue.Boolean(nodeReader.GetInt64 9 <> 0L)); Some("hasMeanTimeToHappen", JsonValue.Boolean(nodeReader.GetInt64 10 <> 0L)) ])
            nodeReader.Close()
            use edgeCommand = connection.CreateCommand()
            let edgeTokenClause = sqliteTokenClause edgeCommand tokens [ "source_kind"; "source_id"; "target_event_id"; "edge_type"; "label"; "source_file" ]
            edgeCommand.CommandText <- "SELECT source_kind, source_id, target_event_id, edge_type, label, source_file, line, confidence FROM event_edges" + edgeTokenClause + " LIMIT $limit"
            addParameter edgeCommand "$limit" (box (max 500 (limit * 20)))
            use edgeReader = edgeCommand.ExecuteReader()
            while edgeReader.Read() && eventEdges.Count < limit do
                let sourceId = edgeReader.GetString 1
                let targetId = edgeReader.GetString 2
                let edgeType = edgeReader.GetString 3
                if matchesTokens tokens [ sourceId; targetId; edgeType; edgeReader.GetString 0 ] then
                    if edgeReader.GetString 0 = "event" then relatedEventIds.Add sourceId |> ignore
                    relatedEventIds.Add targetId |> ignore
                    eventEdges.Add(
                        jsonRecord
                            [ Some("sourceKind", JsonValue.String(edgeReader.GetString 0)); Some("sourceId", JsonValue.String sourceId)
                              Some("targetEventId", JsonValue.String targetId); Some("edgeType", JsonValue.String edgeType)
                              stringOrNone edgeReader 4 |> Option.map (fun value -> "label", JsonValue.String value)
                              Some("sourceFile", JsonValue.String(edgeReader.GetString 5)); Some("line", JsonValue.Number(decimal (edgeReader.GetInt64 6)))
                              Some("confidence", JsonValue.String(edgeReader.GetString 7)) ])
            edgeReader.Close()
            use logicCommand = connection.CreateCommand()
            let logicTokenClause = sqliteTokenClause logicCommand tokens [ "event_id"; "relation_type"; "subject"; "scope"; "phase"; "source_file"; "details" ]
            logicCommand.CommandText <- "SELECT event_id, relation_type, subject, scope, phase, source_file, line, details FROM event_logic" + logicTokenClause + " LIMIT $limit"
            addParameter logicCommand "$limit" (box (max 500 (limit * 20)))
            use logicReader = logicCommand.ExecuteReader()
            let addLogicRow (reader: SqliteDataReader) =
                let eventId = reader.GetString 0
                let relationType = reader.GetString 1
                let subject = reader.GetString 2
                let line = reader.GetInt64 6
                let key = String.Join("|", [| eventId; relationType; subject; string line |])
                if eventLogic.Count < limit && returnedLogicKeys.Add key then
                    relatedEventIds.Add eventId |> ignore
                    logicSubjects.Add subject |> ignore
                    eventLogic.Add(
                        jsonRecord
                            [ Some("eventId", JsonValue.String eventId); Some("relationType", JsonValue.String relationType); Some("subject", JsonValue.String subject)
                              stringOrNone reader 3 |> Option.map (fun value -> "scope", JsonValue.String value)
                              Some("phase", JsonValue.String(reader.GetString 4)); Some("sourceFile", JsonValue.String(reader.GetString 5))
                              Some("line", JsonValue.Number(decimal line))
                              stringOrNone reader 7 |> Option.map (fun value -> "details", JsonValue.String value) ])
            while logicReader.Read() && eventLogic.Count < limit do
                let eventId = logicReader.GetString 0
                let relationType = logicReader.GetString 1
                let subject = logicReader.GetString 2
                if matchesTokens tokens [ eventId; relationType; subject; stringOrNone logicReader 3 |> Option.defaultValue "" ] then
                    addLogicRow logicReader
            logicReader.Close()

            if eventLogic.Count < limit && logicSubjects.Count > 0 then
                use relatedLogicCommand = connection.CreateCommand()
                let subjectParameters =
                    logicSubjects
                    |> Seq.truncate 100
                    |> Seq.mapi (fun index subject ->
                        let parameter = "$logicSubject" + string index
                        addParameter relatedLogicCommand parameter (box subject)
                        parameter)
                    |> Seq.toList
                relatedLogicCommand.CommandText <-
                    "SELECT event_id, relation_type, subject, scope, phase, source_file, line, details FROM event_logic WHERE subject COLLATE NOCASE IN ("
                    + String.concat "," subjectParameters
                    + ") LIMIT $limit"
                addParameter relatedLogicCommand "$limit" (box (limit * 4))
                use relatedLogicReader = relatedLogicCommand.ExecuteReader()
                while relatedLogicReader.Read() && eventLogic.Count < limit do addLogicRow relatedLogicReader
                relatedLogicReader.Close()

            let missingNodeIds =
                relatedEventIds
                |> Seq.filter (returnedNodeIds.Contains >> not)
                |> Seq.truncate limit
                |> Seq.toList
            if eventNodes.Count < limit && not missingNodeIds.IsEmpty then
                use relatedNodeCommand = connection.CreateCommand()
                let nodeParameters =
                    missingNodeIds
                    |> List.mapi (fun index eventId ->
                        let parameter = "$relatedEvent" + string index
                        addParameter relatedNodeCommand parameter (box eventId)
                        parameter)
                relatedNodeCommand.CommandText <-
                    "SELECT event_id, event_type, title, file_path, logical_path, line, end_line, origin, is_triggered_only, is_hidden, has_mtth FROM event_nodes WHERE event_id COLLATE NOCASE IN ("
                    + String.concat "," nodeParameters
                    + ") LIMIT $limit"
                addParameter relatedNodeCommand "$limit" (box limit)
                use relatedNodeReader = relatedNodeCommand.ExecuteReader()
                while relatedNodeReader.Read() && eventNodes.Count < limit do
                    let eventId = relatedNodeReader.GetString 0
                    if returnedNodeIds.Add eventId then
                        eventNodes.Add(
                            jsonRecord
                                [ Some("eventId", JsonValue.String eventId); Some("eventType", JsonValue.String(relatedNodeReader.GetString 1))
                                  stringOrNone relatedNodeReader 2 |> Option.map (fun value -> "title", JsonValue.String value)
                                  Some("file", JsonValue.String(relatedNodeReader.GetString 3)); Some("logicalPath", JsonValue.String(relatedNodeReader.GetString 4))
                                  Some("line", JsonValue.Number(decimal (relatedNodeReader.GetInt64 5))); Some("endLine", JsonValue.Number(decimal (relatedNodeReader.GetInt64 6)))
                                  Some("origin", JsonValue.String(relatedNodeReader.GetString 7)); Some("isTriggeredOnly", JsonValue.Boolean(relatedNodeReader.GetInt64 8 <> 0L))
                                  Some("isHidden", JsonValue.Boolean(relatedNodeReader.GetInt64 9 <> 0L)); Some("hasMeanTimeToHappen", JsonValue.Boolean(relatedNodeReader.GetInt64 10 <> 0L)) ])

        let unresolved = ResizeArray<JsonValue>()
        if options.includeUnresolved then
            use unresolvedCommand = connection.CreateCommand()
            unresolvedCommand.CommandText <- "SELECT kind, entity_type, symbol_id, resolution, message FROM unresolved LIMIT 100"
            use unresolvedReader = unresolvedCommand.ExecuteReader()
            while unresolvedReader.Read() do
                unresolved.Add(
                    jsonRecord
                        [ Some("kind", JsonValue.String(unresolvedReader.GetString 0))
                          stringOrNone unresolvedReader 1 |> Option.map (fun value -> "entityType", JsonValue.String value)
                          stringOrNone unresolvedReader 2 |> Option.map (fun value -> "id", JsonValue.String value)
                          stringOrNone unresolvedReader 3 |> Option.map (fun value -> "resolution", JsonValue.String value)
                          Some("message", JsonValue.String(unresolvedReader.GetString 4)) ])

        jsonRecord
            [ Some("ok", JsonValue.Boolean true)
              Some("status", JsonValue.String(getMetadata "status" "stale"))
              Some("source", JsonValue.String "cwtools-project-knowledge-sqlite")
              Some("schemaVersion", JsonValue.Number 2m)
              Some("databasePath", JsonValue.String(normalizePath databasePath))
              Some("generatedAt", JsonValue.String(getMetadata "generated_at" ""))
              Some("game", JsonValue.String(getMetadata "game" "unknown"))
              Some("graphVersion", JsonValue.Number(decimal (Int64.Parse(getMetadata "graph_version" "0"))))
              Some("domains", jsonStringArray (capabilities |> Seq.map (fun item -> item.GetProperty("domain").AsString())))
              Some("capabilities", JsonValue.Array(capabilities.ToArray()))
              Some("evidence", JsonValue.Array(evidence.ToArray()))
              Some("eventGraph", jsonRecord
                [ Some("nodes", JsonValue.Array(eventNodes.ToArray()))
                  Some("edges", JsonValue.Array(eventEdges.ToArray()))
                  Some("logic", JsonValue.Array(eventLogic.ToArray())) ])
              Some("unresolved", JsonValue.Array(unresolved.ToArray()))
              Some("requiredNextChecks", jsonStringArray
                [ "Use query_cwt_schema/query_rules/query_scope for legality before writing."
                  "Read exact source blocks referenced by event structure and logic evidence."
                  "Verify event scope bridges and state lifecycles before approving complex blueprints." ]) ]

let exportProjectKnowledge (activeGame: string) (projectRoots: string list) (rawOptions: ExportOptions) (runtime: RuntimeMetadata) (game: IGame<'T>) =
    let requestedOptions = normalizeOptions rawOptions
    let incrementalBase =
        match requestedOptions.databasePath with
        | Some databasePath when requestedOptions.generationMode = "incremental" && not requestedOptions.domains.IsEmpty ->
            readRetainedKnowledgeDatabase databasePath requestedOptions.domains
        | _ -> None
    let collectionOptions =
        match requestedOptions.databasePath, incrementalBase with
        | Some _, None -> { requestedOptions with domains = []; generationMode = "full" }
        | _ -> requestedOptions
    let resources = resourceFacts (game :> IGame)
    let freshDefinitions = collectDefinitions (game :> IGame) projectRoots resources collectionOptions
    let freshTopology = collectTopology projectRoots collectionOptions game
    let availableDefinitions, topology, generationMode =
        match incrementalBase with
        | Some(retainedDefinitions, retainedTopology) ->
            let mergedDefinitions =
                Seq.append retainedDefinitions freshDefinitions
                |> Seq.distinctBy (fun item -> item.entityType.ToLowerInvariant(), item.id.ToLowerInvariant(), normalizePath item.file, item.line)
                |> Seq.sortBy (fun item -> item.domain, item.entityType, item.id, item.origin)
                |> Seq.toList
            let mergedTopology =
                { files =
                    Seq.append retainedTopology.files freshTopology.files
                    |> Seq.distinctBy (fun item -> normalizePath item.file)
                    |> Seq.toList
                  edges =
                    Seq.append retainedTopology.edges freshTopology.edges
                    |> Seq.distinctBy (fun item -> normalizePath item.sourceFile, item.targetId, item.typeGroup, item.line, item.referenceType)
                    |> Seq.toList
                  truncated = retainedTopology.truncated || freshTopology.truncated }
            mergedDefinitions, mergedTopology, "incremental"
        | None -> freshDefinitions, freshTopology, collectionOptions.generationMode
    // Even incremental refreshes publish a full normalized database atomically;
    // only the changed domains are re-extracted, while retained rows are loaded
    // from the previous V2 database before stacks and event relationships rebuild.
    let options = { collectionOptions with domains = []; generationMode = generationMode }
    let definitions = selectDefinitions options availableDefinitions
    let domains = domainSummaries options definitions
    let eventGraph = collectEventGraph availableDefinitions topology
    let warnings = ResizeArray<string>()
    if runtime.status <> "ready" then warnings.Add("The knowledge snapshot was exported while CWTools was loading or stale.")
    if definitions.Length < availableDefinitions.Length then
        warnings.Add("Definitions were sampled by maxDefinitions; workspace and event-core definitions were preserved.")
    if definitions |> List.exists (fun item -> item.origin = "vanilla") |> not then warnings.Add("No vanilla definitions were detected in the loaded game model.")

    match options.databasePath with
    | Some databasePath ->
        let storedPath, generatedAt =
            writeKnowledgeDatabase databasePath activeGame projectRoots options runtime definitions topology eventGraph (game :> IGame) warnings
        jsonRecord
            [ Some("ok", JsonValue.Boolean true)
              Some("status", JsonValue.String runtime.status)
              Some("source", JsonValue.String "cwtools-project-knowledge-sqlite")
              Some("schemaVersion", JsonValue.Number 2m)
              Some("game", JsonValue.String activeGame)
              Some("generatedAtUnixMs", JsonValue.Number(decimal (generatedAt.ToUnixTimeMilliseconds())))
              Some("graphVersion", JsonValue.Number(decimal runtime.graphVersion))
              Some("projectRoots", jsonStringArray projectRoots)
              Some("databasePath", JsonValue.String(normalizePath storedPath))
              Some("generationMode", JsonValue.String generationMode)
              Some("domains", JsonValue.Array(compactDomainSummaries definitions))
              Some("counts", jsonRecord
                [ Some("definitions", JsonValue.Number(decimal definitions.Length))
                  Some("availableDefinitions", JsonValue.Number(decimal availableDefinitions.Length))
                  Some("workspaceDefinitions", JsonValue.Number(decimal (definitions |> List.filter (fun item -> item.origin = "workspace") |> List.length)))
                  Some("vanillaDefinitions", JsonValue.Number(decimal (definitions |> List.filter (fun item -> item.origin = "vanilla") |> List.length)))
                  Some("definitionStacks", JsonValue.Number(decimal (definitionStackCount definitions)))
                  Some("topologyFiles", JsonValue.Number(decimal topology.files.Length))
                  Some("topologyEdges", JsonValue.Number(decimal topology.edges.Length))
                  Some("eventNodes", JsonValue.Number(decimal eventGraph.nodes.Length))
                  Some("eventEdges", JsonValue.Number(decimal eventGraph.edges.Length))
                  Some("eventLogic", JsonValue.Number(decimal eventGraph.logic.Length)) ])
              Some("freshness", jsonRecord
                  [ Some("validationInProgress", JsonValue.Boolean runtime.validationInProgress)
                    Some("loadingInProgress", JsonValue.Boolean runtime.loadingInProgress)
                    Some("pendingGlobalKinds", jsonStringArray runtime.pendingGlobalKinds)
                    Some("lastGlobalRefreshAtUnixMs", JsonValue.Number(decimal runtime.lastGlobalRefreshAtUnixMs)) ])
              Some("warnings", jsonStringArray warnings) ]
    | None ->
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
              Some("topology", topologyJson topology)
              Some("overrideModes", JsonValue.Array(overrideModesJson (game :> IGame)))
              Some("overrideModeInfo", JsonValue.Array(overrideModeInfoJson (game :> IGame)))
              Some("freshness", jsonRecord
                  [ Some("validationInProgress", JsonValue.Boolean runtime.validationInProgress)
                    Some("loadingInProgress", JsonValue.Boolean runtime.loadingInProgress)
                    Some("pendingGlobalKinds", jsonStringArray runtime.pendingGlobalKinds)
                    Some("lastGlobalRefreshAtUnixMs", JsonValue.Number(decimal runtime.lastGlobalRefreshAtUnixMs)) ])
              Some("warnings", jsonStringArray warnings) ]
