module Main.ProjectKnowledge

open System
open System.Collections.Concurrent
open System.Collections.Generic
open System.IO
open System.Text.RegularExpressions
open FSharp.Data
open Microsoft.Data.Sqlite
open CWTools.Games
open CWTools.Process
open CWTools.Utilities.Position
open CWTools.Utilities.StringResource

type ExportOptions =
    { domains: string list
      changedFiles: string list
      maxDefinitions: int
      maxTopologyFiles: int
      maxEdges: int
      archetypesPerDomain: int
      completeExport: bool
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
      hasMeanTimeToHappen: bool
      factsKnown: bool }

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

let private normalizePath (value: string) =
    value.Replace('\\', '/').Trim()

let private normalizeFileKey (value: string) =
    let normalized = value |> Path.GetFullPath |> normalizePath
    if OperatingSystem.IsWindows() then normalized.ToLowerInvariant() else normalized

let normalizeOptions (options: ExportOptions) : ExportOptions =
    { domains =
        options.domains
        |> List.map (fun value -> value.Trim().ToLowerInvariant())
        |> List.filter (String.IsNullOrWhiteSpace >> not)
        |> List.distinct
      changedFiles =
        options.changedFiles
        |> List.map normalizeFileKey
        |> List.distinct
      maxDefinitions = clamp 100 250000 options.maxDefinitions
      maxTopologyFiles = clamp 10 3000 options.maxTopologyFiles
      maxEdges = clamp 100 20000 options.maxEdges
      archetypesPerDomain = clamp 1 20 options.archetypesPerDomain
      completeExport = options.completeExport
      databasePath = options.databasePath
      generationMode = if options.generationMode = "incremental" then "incremental" else "full" }

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

let isKnowledgeDatabasePathAllowed (projectRoots: string list) (databasePath: string) =
    let target = Path.GetFullPath databasePath
    projectRoots |> List.exists (fun root -> pathInside root target)

let private knowledgeTemporaryFileLegacyMaxAge = TimeSpan.FromMinutes 30.0
let private knowledgeTemporaryDeleteAttempts = 3

let private tryDeleteKnowledgeTemporaryFile (filePath: string) =
    let mutable deleted = not (File.Exists filePath)
    let mutable attempt = 0
    let mutable lastError: exn option = None
    while not deleted && attempt < knowledgeTemporaryDeleteAttempts do
        attempt <- attempt + 1
        try
            File.Delete filePath
            deleted <- not (File.Exists filePath)
        with e ->
            lastError <- Some e
            if attempt < knowledgeTemporaryDeleteAttempts then
                Threading.Thread.Sleep 25
    if not deleted then
        let detail = lastError |> Option.map _.Message |> Option.defaultValue "file still exists"
        CWTools.Utilities.Utils.logWarning
            $"Failed to delete project knowledge temporary database after {knowledgeTemporaryDeleteAttempts} attempts: {filePath} ({detail})"
    deleted

let private temporaryFileOwnerProcessId (fileName: string) (prefix: string) =
    if not (fileName.StartsWith(prefix, comparison)) then None
    else
        let suffix = fileName.Substring(prefix.Length)
        let separator = suffix.IndexOf('-')
        if separator <= 0 then None
        else
            match Int32.TryParse(suffix.Substring(0, separator)) with
            | true, processId when processId > 0 -> Some processId
            | _ -> None

let private processIsRunning processId =
    try
        use ownerProcess = Diagnostics.Process.GetProcessById processId
        not ownerProcess.HasExited
    with
    | :? ArgumentException -> false
    | _ -> true

/// Remove abandoned full-export databases without touching a temporary file
/// owned by another live language-server process. Legacy GUID-only files have
/// no owner metadata, so they are removed only after a conservative age guard.
let cleanupStaleKnowledgeTemporaryFiles (databasePath: string) =
    let target = Path.GetFullPath databasePath
    let directory = Path.GetDirectoryName target
    if not (String.IsNullOrWhiteSpace directory) && Directory.Exists directory then
        let prefix = Path.GetFileName(target) + ".tmp-"
        let legacyCutoff = DateTime.UtcNow - knowledgeTemporaryFileLegacyMaxAge
        try
            for candidate in Directory.EnumerateFiles(directory, prefix + "*", SearchOption.TopDirectoryOnly) do
                try
                    let ownerProcessId =
                        temporaryFileOwnerProcessId (Path.GetFileName candidate) prefix
                    let shouldDelete =
                        match ownerProcessId with
                        | Some processId -> not (processIsRunning processId)
                        | None -> File.GetLastWriteTimeUtc(candidate) <= legacyCutoff
                    if shouldDelete then
                        tryDeleteKnowledgeTemporaryFile candidate |> ignore
                with e ->
                    CWTools.Utilities.Utils.logWarning
                        $"Failed to inspect project knowledge temporary database {candidate}: {e.Message}"
        with e ->
            CWTools.Utilities.Utils.logWarning
                $"Failed to enumerate project knowledge temporary databases beside {target}: {e.Message}"

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

let private domainFor (entityType: string) (logicalPath: string) =
    let normalizedType = entityType.Trim().ToLowerInvariant().Replace('-', '_')
    if not (String.IsNullOrWhiteSpace normalizedType) then normalizedType
    else
        let normalized = (normalizePath (logicalPath.TrimStart('/'))).ToLowerInvariant()
        let segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries)
        let commonIndex = segments |> Array.tryFindIndex (fun segment -> segment = "common")
        match commonIndex with
        | Some index when index + 1 < segments.Length -> segments.[index + 1].Replace('-', '_')
        | _ when segments.Length > 0 -> segments.[0].Replace('-', '_')
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

let private shaderEntityType =
    function
    | PdxShaderRuntime.EffectDeclaration -> "shader_effect", []
    | PdxShaderRuntime.VertexMainCodeDeclaration -> "shader_maincode", [ "vertex" ]
    | PdxShaderRuntime.PixelMainCodeDeclaration -> "shader_maincode", [ "pixel" ]
    | PdxShaderRuntime.GeometryMainCodeDeclaration -> "shader_maincode", [ "geometry" ]
    | PdxShaderRuntime.VertexStructDeclaration -> "shader_struct", [ "vertex" ]
    | PdxShaderRuntime.ConstantBufferDeclaration -> "shader_constant_buffer", []
    | PdxShaderRuntime.SamplerDeclaration -> "shader_sampler", []
    | PdxShaderRuntime.ShaderResourceDeclaration -> "shader_resource", []
    | PdxShaderRuntime.HlslTypeDeclaration -> "shader_hlsl_type", []
    | PdxShaderRuntime.HlslFunctionDeclaration -> "shader_hlsl_function", []
    | PdxShaderRuntime.HlslVariableDeclaration -> "shader_hlsl_variable", []
    | PdxShaderRuntime.MacroDeclaration -> "shader_macro", []
    | PdxShaderRuntime.BlendStateDeclaration -> "shader_render_state", [ "blend" ]
    | PdxShaderRuntime.DepthStencilStateDeclaration -> "shader_render_state", [ "depth_stencil" ]
    | PdxShaderRuntime.RasterizerStateDeclaration -> "shader_render_state", [ "rasterizer" ]

let private shaderOriginName =
    function
    | PdxShaderProject.Vanilla -> "vanilla"
    | PdxShaderProject.Dependency _ -> "dependency"
    | PdxShaderProject.CurrentDocument
    | PdxShaderProject.Workspace -> "workspace"

let private collectShaderDefinitions (model: PdxShaderRuntime.ShaderRuntimeModel option) (resources: IDictionary<string, ResourceFact>) =
    match model with
    | None -> []
    | Some model ->
        let declarations =
            model.declarations
            |> List.map (fun declaration ->
                let resource = resourceForFile resources declaration.file
                let entityType, subtypes = shaderEntityType declaration.kind

                { id = declaration.stableId
                  entityType = entityType
                  file = declaration.file
                  logicalPath = declaration.logicalPath
                  line = int declaration.range.StartLine
                  endLine = int declaration.range.EndLine
                  origin = shaderOriginName declaration.origin
                  validate = true
                  subtypes = subtypes
                  overwrite = resource |> Option.map (fun item -> item.overwrite) |> Option.defaultValue "none"
                  resourceScope = resource |> Option.map (fun item -> item.scope) |> Option.filter (String.IsNullOrWhiteSpace >> not)
                  domain = "shader"
                  overridePath = None
                  overrideStrategy = None })

        let interfaceSprites =
            model.interfaceSprites
            |> List.choose (fun invocation ->
                invocation.spriteName
                |> Option.map (fun spriteName ->
                    let resource = resourceForFile resources invocation.sourceFile

                    { id = spriteName
                      entityType = "shader_interface_sprite"
                      file = invocation.sourceFile
                      logicalPath = invocation.logicalPath
                      line = int invocation.blockRange.StartLine
                      endLine = int invocation.blockRange.EndLine
                      origin = shaderOriginName invocation.origin
                      validate = true
                      subtypes = [ invocation.rendererSubtype ]
                      overwrite = resource |> Option.map (fun item -> item.overwrite) |> Option.defaultValue "none"
                      resourceScope = resource |> Option.map (fun item -> item.scope) |> Option.filter (String.IsNullOrWhiteSpace >> not)
                      domain = "shader"
                      overridePath = None
                      overrideStrategy = None }))

        let rendererContractSource =
            PdxShaderRuntime.spriteRendererContractInfo ()
            |> fst
            |> Option.defaultValue "shader/renderer-contracts.json"

        let rendererContracts =
            model.rendererContracts
            |> List.map (fun contract ->
                { id = sprintf "%s:%s:%s" contract.gameVersion contract.rendererSubtype (normalizePath contract.shaderFile)
                  entityType = "shader_renderer_contract"
                  file = rendererContractSource
                  logicalPath = "shader/renderer-contracts.json"
                  line = 1
                  endLine = 1
                  origin = "curated"
                  validate = true
                  subtypes = [ contract.rendererSubtype; contract.gameVersion ]
                  overwrite = "none"
                  resourceScope = None
                  domain = "shader"
                  overridePath = None
                  overrideStrategy = None })

        let abiAuditDefinitions =
            match PdxShaderRuntime.shaderAbiAuditInfo () with
            | source, Some audit, diagnostics when List.isEmpty diagnostics ->
                [ { id = sprintf "%s:abi-audit" audit.gameVersion
                    entityType = "shader_abi_audit"
                    file = source |> Option.defaultValue "shader/abi-audit.json"
                    logicalPath = "shader/abi-audit.json"
                    line = 1
                    endLine = 1
                    origin = "curated"
                    validate = true
                    subtypes =
                        [ audit.reviewStatus
                          if audit.stale then "stale" else "current"
                          sprintf "confirmed:%d" audit.confirmedEngineEntries.Length ]
                    overwrite = "none"
                    resourceScope = None
                    domain = "shader"
                    overridePath = None
                    overrideStrategy = None } ]
            | _ -> []

        declarations @ interfaceSprites @ rendererContracts @ abiAuditDefinitions

let private collectDefinitions (game: IGame) (projectRoots: string list) (resources: IDictionary<string, ResourceFact>) (shaderModel: PdxShaderRuntime.ShaderRuntimeModel option) (options: ExportOptions) : DefinitionFact list =
    let changedFiles = options.changedFiles |> Set.ofList

    let typedDefinitions =
        game.Types()
        |> Map.toSeq
        |> Seq.collect (fun (entityType, values) ->
            values
            |> (fun definitions ->
                if not changedFiles.IsEmpty && options.domains.IsEmpty then
                    definitions
                    |> Seq.filter (fun definition -> changedFiles.Contains(normalizeFileKey definition.range.FileName))
                else
                    definitions)
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

    Seq.append typedDefinitions (collectShaderDefinitions shaderModel resources)
    |> Seq.filter (fun definition ->
        (options.domains.IsEmpty && changedFiles.IsEmpty)
        || options.domains |> List.contains definition.domain
        || changedFiles.Contains(normalizeFileKey definition.file))
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
    if options.completeExport || definitions.Length <= options.maxDefinitions then definitions
    else
        let workspace, vanilla = definitions |> List.partition (fun item -> item.origin = "workspace")
        let remaining = max 0 (options.maxDefinitions - workspace.Length)
        let selectedVanilla = balancedTakeDefinitions remaining vanilla
        Seq.concat [ workspace; selectedVanilla ]
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

let private collectTopology (projectRoots: string list) (options: ExportOptions) (shaderModel: PdxShaderRuntime.ShaderRuntimeModel option) (game: IGame<'T>) : TopologyFacts =
    let files = ResizeArray<FileFact>()
    let edges = ResizeArray<ReferenceFact>()
    let pathComparer = if OperatingSystem.IsWindows() then StringComparer.OrdinalIgnoreCase else StringComparer.Ordinal
    let seenFiles = HashSet<string>(pathComparer)
    let seenEdges = HashSet<struct (string * string * string * int * string)>()
    let mutable fileCount = 0
    let mutable fileLimitExceeded = false
    let mutable edgeLimitExceeded = false
    let changedFiles = options.changedFiles |> Set.ofList

    for struct (entity, lazyData) in game.AllEntities() do
        if originForPath projectRoots entity.filepath = "workspace" then
            let domain = domainFor "" entity.logicalpath
            if (options.domains.IsEmpty && changedFiles.IsEmpty)
               || options.domains |> List.contains domain
               || changedFiles.Contains(normalizeFileKey entity.filepath) then
                let normalizedFile = normalizePath entity.filepath
                if not (seenFiles.Add normalizedFile) then
                    ()
                elif not options.completeExport && fileCount >= options.maxTopologyFiles then
                    fileLimitExceeded <- true
                else
                    fileCount <- fileCount + 1
                    let data = lazyData.Force()
                    data.Referencedtypes
                    |> Option.iter (fun groups ->
                        for typeGroup, values in groups |> Map.toSeq do
                            for reference in values do
                                let target = stringManager.GetStringForIDs reference.originalValue
                                if not (String.IsNullOrWhiteSpace target) then
                                    let referenceType = reference.referenceType.ToString()
                                    let line = int reference.position.StartLine
                                    let edgeKey = struct (normalizedFile, target, typeGroup, line, referenceType)
                                    if not (seenEdges.Contains edgeKey) then
                                        if options.completeExport || edges.Count < options.maxEdges then
                                            seenEdges.Add edgeKey |> ignore
                                            edges.Add(
                                                { sourceFile = normalizedFile
                                                  sourceLogicalPath = normalizePath entity.logicalpath
                                                  targetId = target
                                                  typeGroup = typeGroup
                                                  line = line
                                                  isOutgoing = reference.isOutgoing
                                                  referenceType = referenceType
                                                  label = reference.referenceLabel
                                                  associatedType = reference.associatedType
                                                  domain = domain })
                                        else
                                            edgeLimitExceeded <- true)
                    files.Add(
                        { file = normalizedFile
                          logicalPath = normalizePath entity.logicalpath
                          domain = domain
                          origin = originForPath projectRoots entity.filepath })

    let shaderSourceSelected sourceFile =
        (options.domains.IsEmpty && changedFiles.IsEmpty)
        || options.domains |> List.contains "shader"
        || changedFiles.Contains(normalizeFileKey sourceFile)

    let addShaderFile sourceFile sourceLogicalPath origin =
        let normalizedFile = normalizePath sourceFile

        if seenFiles.Add normalizedFile then
            if options.completeExport || fileCount < options.maxTopologyFiles then
                fileCount <- fileCount + 1
                files.Add
                    { file = normalizedFile
                      logicalPath = normalizePath sourceLogicalPath
                      domain = "shader"
                      origin = origin }
            else
                fileLimitExceeded <- true

    let addShaderEdge sourceFile sourceLogicalPath origin targetId typeGroup line referenceType label associatedType =
        if shaderSourceSelected sourceFile && not (String.IsNullOrWhiteSpace targetId) then
            addShaderFile sourceFile sourceLogicalPath origin
            let normalizedFile = normalizePath sourceFile
            let edgeKey = struct (normalizedFile, targetId, typeGroup, line, referenceType)

            if seenEdges.Add edgeKey then
                if options.completeExport || edges.Count < options.maxEdges then
                    edges.Add
                        { sourceFile = normalizedFile
                          sourceLogicalPath = normalizePath sourceLogicalPath
                          targetId = targetId
                          typeGroup = typeGroup
                          line = line
                          isOutgoing = true
                          referenceType = referenceType
                          label = label
                          associatedType = associatedType
                          domain = "shader" }
                else
                    edgeLimitExceeded <- true

    shaderModel
    |> Option.iter (fun model ->
        for snapshot in model.snapshots do
            let origin = shaderOriginName snapshot.origin

            for includeEntry in PdxShaderProject.extractIncludes snapshot do
                let targetId, referenceType, associatedType =
                    match PdxShaderProject.resolveInclude model.snapshots snapshot includeEntry.target with
                    | PdxShaderProject.Resolved(best :: _) ->
                        normalizePath best.logicalPath, "includes", Some "resolved"
                    | PdxShaderProject.Resolved [] ->
                        normalizePath includeEntry.target, "includes_missing", Some "missing"
                    | PdxShaderProject.Ambiguous _ ->
                        normalizePath includeEntry.target, "includes_ambiguous", Some "ambiguous"
                    | PdxShaderProject.Missing ->
                        normalizePath includeEntry.target, "includes_missing", Some "missing"

                let includeRange =
                    PdxShaderRuntime.offsetRange snapshot.displayPath snapshot.text includeEntry.start includeEntry.length

                addShaderEdge
                    snapshot.displayPath
                    snapshot.logicalPath
                    origin
                    targetId
                    "shader_file"
                    (int includeRange.StartLine)
                    referenceType
                    (Some "Includes")
                    associatedType

        for declaration in model.declarations do
            let entityType, subtypes = shaderEntityType declaration.kind

            addShaderEdge
                declaration.file
                declaration.logicalPath
                (shaderOriginName declaration.origin)
                declaration.stableId
                entityType
                (int declaration.selectionRange.StartLine)
                "declares_shader_symbol"
                None
                (subtypes |> List.tryHead)

        for reference in model.semanticReferences do
            let typeGroup, referenceType =
                match reference.kind with
                | PdxShaderRuntime.EffectUsesVertexMainCode
                | PdxShaderRuntime.EffectUsesPixelMainCode
                | PdxShaderRuntime.EffectUsesGeometryMainCode -> "shader_maincode", "effect_uses_maincode"
                | PdxShaderRuntime.EffectUsesRenderState -> "shader_render_state", "effect_uses_render_state"
                | PdxShaderRuntime.MainCodeUsesConstantBuffer -> "shader_constant_buffer", "maincode_uses_constant_buffer"
                | PdxShaderRuntime.HlslCallsFunction -> "shader_hlsl_function", "hlsl_calls_function"
                | PdxShaderRuntime.HlslUsesType -> "shader_hlsl_type", "hlsl_uses_type"
                | PdxShaderRuntime.HlslUsesMember -> "shader_hlsl_variable", "hlsl_uses_member"
                | PdxShaderRuntime.HlslUsesSymbol -> "shader_hlsl_variable", "hlsl_uses_symbol"
            let targets = if reference.targetIds.IsEmpty then [ reference.targetName ] else reference.targetIds

            for target in targets do
                addShaderEdge
                    reference.file
                    reference.logicalPath
                    (shaderOriginName reference.origin)
                    target
                    typeGroup
                    (int reference.span.StartLine)
                    referenceType
                    reference.sourceName
                    (Some(sprintf "%s | %s" reference.stage reference.presenceCondition))

        for evidence in model.evidence do
            let targetId, typeGroup, referenceType, label, associatedType =
                match evidence.kind with
                | PdxShaderRuntime.ShaderAssignment ->
                    evidence.value, "shader_effect", "calls_shader_effect", evidence.enclosingBlock, None
                | PdxShaderRuntime.EffectFileSelection ->
                    normalizePath evidence.value,
                    "shader_file",
                    (if evidence.interfaceSprite.IsSome then "interface_sprite_selects_shader_file" else "effect_file_selects_shader_file"),
                    (evidence.interfaceSprite |> Option.orElse evidence.enclosingBlock),
                    evidence.rendererSubtype

            addShaderEdge
                evidence.sourceFile
                evidence.logicalPath
                (shaderOriginName evidence.origin)
                targetId
                typeGroup
                (int evidence.span.StartLine)
                referenceType
                label
                associatedType

        for invocation in model.interfaceSprites do
            for input in invocation.resourceInputs do
                addShaderEdge
                    invocation.sourceFile
                    invocation.logicalPath
                    (shaderOriginName invocation.origin)
                    (normalizePath input.value)
                    "shader_renderer_input"
                    (int input.span.StartLine)
                    "renderer_input"
                    (Some input.field)
                    (Some invocation.rendererSubtype)

            match PdxShaderRuntime.rendererContractForInvocation model invocation with
            | Some contract ->
                for effectName in contract.effects do
                    addShaderEdge
                        invocation.sourceFile
                        invocation.logicalPath
                        (shaderOriginName invocation.origin)
                        effectName
                        "shader_effect"
                        (int invocation.shaderFileSpan.StartLine)
                        "renderer_contract_selects_effect"
                        invocation.spriteName
                        (Some(sprintf "%s@%s" invocation.rendererSubtype contract.gameVersion))
            | None -> ()

        for guiUse in model.guiSpriteUses do
            addShaderEdge
                guiUse.sourceFile
                guiUse.logicalPath
                (shaderOriginName guiUse.origin)
                guiUse.spriteName
                "shader_interface_sprite"
                (int guiUse.span.StartLine)
                "gui_uses_interface_sprite"
                guiUse.enclosingBlock
                None)

    { files = files |> Seq.sortBy (fun item -> item.file, item.logicalPath) |> Seq.toList
      edges =
        edges
        |> Seq.sortBy (fun item -> item.sourceFile, item.line, item.typeGroup, item.targetId, item.referenceType)
        |> Seq.toList
      truncated = fileLimitExceeded || edgeLimitExceeded }

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

type private EventSyntaxFact =
    { title: string option
      isTriggeredOnly: bool
      isHidden: bool
      hasMeanTimeToHappen: bool }

let orientTypedReference sourceId targetId isOutgoing =
    if isOutgoing then sourceId, targetId else targetId, sourceId

let private tryParsePdxBoolean (value: string) =
    match value.Trim().ToLowerInvariant() with
    | "yes" | "true" | "1" -> Some true
    | "no" | "false" | "0" -> Some false
    | _ -> None

let private tryDirectLeafValue key (node: Node) =
    node.Leaves
    |> Seq.tryFind (fun leaf -> leaf.Key.Equals(key, StringComparison.OrdinalIgnoreCase))
    |> Option.map (fun leaf -> leaf.ValueText)

let rec private descendantNodes (node: Node) =
    seq {
        yield node
        for child in node.Nodes do
            yield! descendantNodes child
    }

let private collectEventSyntaxFacts (game: IGame<'T>) (definitions: DefinitionFact list) =
    let pathComparer = if OperatingSystem.IsWindows() then StringComparer.OrdinalIgnoreCase else StringComparer.Ordinal
    let rootsByFile = Dictionary<string, ResizeArray<Node>>(pathComparer)
    for struct (entity, _) in game.AllEntities() do
        let file = normalizePath entity.filepath
        let roots =
            match rootsByFile.TryGetValue file with
            | true, values -> values
            | false, _ ->
                let values = ResizeArray<Node>()
                rootsByFile.[file] <- values
                values
        roots.Add entity.rawEntity

    definitions
    |> Seq.choose (fun definition ->
        match rootsByFile.TryGetValue(normalizePath definition.file) with
        | false, _ -> None
        | true, roots ->
            roots
            |> Seq.collect descendantNodes
            |> Seq.filter (fun node ->
                int node.Position.StartLine <= definition.line
                && int node.Position.EndLine >= definition.endLine)
            |> Seq.sortBy (fun node -> int node.Position.EndLine - int node.Position.StartLine)
            |> Seq.tryHead
            |> Option.map (fun node ->
                let booleanField key =
                    tryDirectLeafValue key node
                    |> Option.bind tryParsePdxBoolean
                    |> Option.defaultValue false
                let fact =
                    { title = tryDirectLeafValue "title" node
                      isTriggeredOnly = booleanField "is_triggered_only"
                      isHidden = booleanField "hide_window"
                      hasMeanTimeToHappen =
                        node.Nodes
                        |> Seq.exists (fun child -> child.Key.Equals("mean_time_to_happen", StringComparison.OrdinalIgnoreCase)) }
                (normalizePath definition.file, definition.line, definition.id.ToLowerInvariant()), fact))
    |> Map.ofSeq

let private collectEventGraphWithKnownIds (knownEventIds: Set<string>) (options: ExportOptions) (definitions: DefinitionFact list) (topology: TopologyFacts) (game: IGame<'T>) : EventGraphFacts =
    let pathComparer = if OperatingSystem.IsWindows() then StringComparer.OrdinalIgnoreCase else StringComparer.Ordinal
    let eventDefinitions =
        definitions
        |> List.filter (fun definition -> definition.entityType.Equals("event", StringComparison.OrdinalIgnoreCase))
        |> List.distinctBy (fun definition -> normalizePath definition.file, definition.line, definition.id)
        |> List.sortBy (fun definition -> normalizePath definition.file, definition.line, definition.id)
    let eventIds =
        eventDefinitions
        |> Seq.map (fun item -> item.id.ToLowerInvariant())
        |> Set.ofSeq
        |> Set.union knownEventIds
    let nodes = ResizeArray<EventNodeFact>()
    let edges = ResizeArray<EventEdgeFact>()
    let logic = ResizeArray<EventLogicFact>()
    let syntaxFacts = collectEventSyntaxFacts game eventDefinitions

    for definition in eventDefinitions do
        let eventType = definition.subtypes |> List.tryHead |> Option.defaultValue definition.entityType
        let syntaxFact = syntaxFacts |> Map.tryFind (normalizePath definition.file, definition.line, definition.id.ToLowerInvariant())
        nodes.Add
            { eventId = definition.id
              eventType = eventType
              title = syntaxFact |> Option.bind (fun fact -> fact.title)
              file = normalizePath definition.file
              logicalPath = normalizePath definition.logicalPath
              line = definition.line
              endLine = definition.endLine
              origin = definition.origin
              isTriggeredOnly = syntaxFact |> Option.exists (fun fact -> fact.isTriggeredOnly)
              isHidden = syntaxFact |> Option.exists (fun fact -> fact.isHidden)
              hasMeanTimeToHappen = syntaxFact |> Option.exists (fun fact -> fact.hasMeanTimeToHappen)
              factsKnown = syntaxFact.IsSome }

    let nodeByFile = Dictionary<string, EventNodeFact list>(pathComparer)
    for file, values in nodes |> Seq.groupBy (fun node -> normalizePath node.file) do
        nodeByFile.[file] <- values |> Seq.toList

    // Index source definitions once instead of rescanning the complete game
    // model for every CWTools-typed incoming event reference.
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
                let sourceId, targetEventId =
                    orientTypedReference node.eventId reference.targetId reference.isOutgoing
                edges.Add
                    { sourceKind = "event"
                      sourceId = sourceId
                      targetEventId = targetEventId
                      edgeType = "typed_reference"
                      label = reference.label
                      sourceFile = reference.sourceFile
                      line = reference.line
                      confidence = "lsp" }
                reference.associatedType
                |> Option.iter (fun scope ->
                    logic.Add
                        { eventId = sourceId
                          relationType = "scope_bridge"
                          subject = targetEventId
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
                |> Option.filter (fun _ -> reference.isOutgoing)
                |> Option.iter (fun definition ->
                    edges.Add
                        { sourceKind = definition.entityType
                          sourceId = definition.id
                          targetEventId = reference.targetId
                          edgeType = "typed_entry"
                          label = reference.label
                          sourceFile = reference.sourceFile
                          line = reference.line
                          confidence = "lsp" })

    let distinctEdges = edges |> Seq.distinctBy (fun item -> item.sourceKind, item.sourceId, item.targetEventId, item.edgeType, item.line)
    let distinctLogic = logic |> Seq.distinctBy (fun item -> item.eventId, item.relationType, item.subject, item.scope, item.line)
    { nodes = nodes |> Seq.distinctBy (fun item -> item.eventId, item.file, item.line) |> Seq.toList
      edges = (if options.completeExport then distinctEdges else distinctEdges |> Seq.truncate 30000) |> Seq.toList
      logic = (if options.completeExport then distinctLogic else distinctLogic |> Seq.truncate 30000) |> Seq.toList }

let private collectEventGraph options definitions topology game =
    collectEventGraphWithKnownIds Set.empty options definitions topology game

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
  has_mtth INTEGER NOT NULL,
  facts_known INTEGER NOT NULL
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
CREATE INDEX idx_definitions_stack ON definitions(entity_type COLLATE NOCASE, symbol_id COLLATE NOCASE);
CREATE INDEX idx_definitions_domain_origin ON definitions(domain, origin);
CREATE INDEX idx_definitions_file ON definitions(file_path COLLATE NOCASE, line);
CREATE INDEX idx_references_target ON references_graph(target_id COLLATE NOCASE);
CREATE INDEX idx_references_source ON references_graph(source_file COLLATE NOCASE, line);
CREATE INDEX idx_event_nodes_id ON event_nodes(event_id COLLATE NOCASE);
CREATE INDEX idx_event_nodes_file ON event_nodes(file_path COLLATE NOCASE, line);
CREATE INDEX idx_event_edges_source ON event_edges(source_id COLLATE NOCASE);
CREATE INDEX idx_event_edges_target ON event_edges(target_event_id COLLATE NOCASE);
CREATE INDEX idx_event_edges_file ON event_edges(source_file COLLATE NOCASE, line);
CREATE INDEX idx_event_logic_event ON event_logic(event_id COLLATE NOCASE);
CREATE INDEX idx_event_logic_subject ON event_logic(subject COLLATE NOCASE);
CREATE INDEX idx_event_logic_file ON event_logic(source_file COLLATE NOCASE, line);
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
    let allowed = isKnowledgeDatabasePathAllowed projectRoots target
    if not allowed then invalidArg "databasePath" "Project knowledge database must be inside a project root."
    Directory.CreateDirectory(Path.GetDirectoryName target) |> ignore
    cleanupStaleKnowledgeTemporaryFiles target
    let temporary =
        target
        + ".tmp-"
        + Environment.ProcessId.ToString()
        + "-"
        + Guid.NewGuid().ToString("N")
    if File.Exists temporary then File.Delete temporary
    use temporaryCleanup =
        { new IDisposable with
            member _.Dispose() =
                if File.Exists temporary then
                    tryDeleteKnowledgeTemporaryFile temporary |> ignore }
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
    insertMetadata "schema_version" "3"
    insertMetadata "status" runtime.status
    insertMetadata "game" activeGame
    insertMetadata "generated_at" (generatedAt.ToString("O"))
    insertMetadata "generated_at_unix_ms" (generatedAt.ToUnixTimeMilliseconds().ToString())
    insertMetadata "graph_version" (runtime.graphVersion.ToString())
    insertMetadata "project_roots" (JsonValue.Array(projectRoots |> List.map JsonValue.String |> List.toArray).ToString(JsonSaveOptions.DisableFormatting))
    insertMetadata "generation_mode" options.generationMode
    insertMetadata "complete_export" (if options.completeExport then "true" else "false")
    insertMetadata "validation_in_progress" ((string runtime.validationInProgress).ToLowerInvariant())
    insertMetadata "loading_in_progress" ((string runtime.loadingInProgress).ToLowerInvariant())
    insertMetadata "pending_global_kinds" (JsonValue.Array(runtime.pendingGlobalKinds |> List.map JsonValue.String |> List.toArray).ToString(JsonSaveOptions.DisableFormatting))
    insertMetadata "last_global_refresh_at_unix_ms" (runtime.lastGlobalRefreshAtUnixMs.ToString())
    insertMetadata "topology_truncated" ((string topology.truncated).ToLowerInvariant())
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
    eventNodeCommand.CommandText <- "INSERT INTO event_nodes(event_id, event_type, title, file_path, logical_path, line, end_line, origin, is_triggered_only, is_hidden, has_mtth, facts_known) VALUES ($id, $type, $title, $file, $logical, $line, $end, $origin, $triggered, $hidden, $mtth, $factsKnown)"
    prepareCommandParameters eventNodeCommand
        [ "$id", box ""; "$type", box ""; "$title", box ""; "$file", box ""; "$logical", box ""; "$line", box 0
          "$end", box 0; "$origin", box ""; "$triggered", box 0; "$hidden", box 0; "$mtth", box 0; "$factsKnown", box 0 ]
    for node in eventGraph.nodes do
        setPreparedCommandParameters eventNodeCommand
            [ "$id", box node.eventId; "$type", box node.eventType; "$title", box (node.title |> Option.toObj); "$file", box node.file
              "$logical", box node.logicalPath; "$line", box node.line; "$end", box node.endLine; "$origin", box node.origin
              "$triggered", box (if node.isTriggeredOnly then 1 else 0); "$hidden", box (if node.isHidden then 1 else 0)
              "$mtth", box (if node.hasMeanTimeToHappen then 1 else 0); "$factsKnown", box (if node.factsKnown then 1 else 0) ]
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

let private readRetainedKnowledgeDatabase (databasePath: string) (excludedDomains: string list) (excludedFiles: string list) =
    if not (File.Exists databasePath) then None
    else
        try
            let excluded = excludedDomains |> Seq.map (fun value -> value.ToLowerInvariant()) |> Set.ofSeq
            let excludedPaths = excludedFiles |> Set.ofList
            let connectionString = SqliteConnectionStringBuilder(DataSource = databasePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false).ToString()
            use connection = new SqliteConnection(connectionString)
            connection.Open()
            let metadata = readMetadata connection
            let retainedTopologyTruncated =
                match metadata.TryGetValue "topology_truncated" with
                | true, value -> String.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
                | _ -> false

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
                let file = normalizePath (definitionReader.GetString 3)
                if not (excluded.Contains(domain.ToLowerInvariant()) || excludedPaths.Contains(normalizeFileKey file)) then
                    let definitionId = definitionReader.GetInt64 0
                    let definitionSubtypes =
                        match subtypes.TryGetValue definitionId with
                        | true, values -> values |> Seq.toList
                        | _ -> []
                    definitions.Add
                        { id = definitionReader.GetString 1
                          entityType = definitionReader.GetString 2
                          file = file
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
                let file = normalizePath (fileReader.GetString 0)
                if not (excluded.Contains(domain.ToLowerInvariant()) || excludedPaths.Contains(normalizeFileKey file)) then
                    files.Add
                        { file = file
                          logicalPath = fileReader.GetString 1
                          domain = domain
                          origin = fileReader.GetString 3 }

            let edges = ResizeArray<ReferenceFact>()
            use edgeCommand = connection.CreateCommand()
            edgeCommand.CommandText <- "SELECT source_file, source_logical_path, target_id, type_group, line, is_outgoing, reference_type, label, associated_type, domain FROM references_graph"
            use edgeReader = edgeCommand.ExecuteReader()
            while edgeReader.Read() do
                let domain = edgeReader.GetString 9
                let sourceFile = normalizePath (edgeReader.GetString 0)
                if not (excluded.Contains(domain.ToLowerInvariant()) || excludedPaths.Contains(normalizeFileKey sourceFile)) then
                    edges.Add
                        { sourceFile = sourceFile
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
                  truncated = retainedTopologyTruncated })
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

let private queryIdentifiers (options: QueryOptions) =
    options.identifiers
    |> List.map (fun value -> value.Trim().ToLowerInvariant())
    |> List.filter (String.IsNullOrWhiteSpace >> not)
    |> List.distinct
    |> List.truncate 20

let private matchesTokens (tokens: string list) (values: string seq) =
    if tokens.IsEmpty then true
    else
        let text = String.Join(" ", values).ToLowerInvariant()
        tokens |> List.exists text.Contains

let private sqliteTokenPredicate (command: SqliteCommand) (tokens: string list) (columns: string list) =
    if tokens.IsEmpty then None
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
        |> Some

let private escapeLikePrefix (value: string) =
    value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%"

let private sqliteIndexedIdentifierPredicate (command: SqliteCommand) parameterPrefix (identifiers: string list) (columns: string list) =
    if identifiers.IsEmpty then None
    else
        identifiers
        |> List.mapi (fun index identifier ->
            let exactParameter = $"${parameterPrefix}Exact{index}"
            let prefixParameter = $"${parameterPrefix}Prefix{index}"
            addParameter command exactParameter (box identifier)
            addParameter command prefixParameter (box (escapeLikePrefix identifier))
            columns
            |> List.map (fun column ->
                $"({column} COLLATE NOCASE = {exactParameter} OR {column} COLLATE NOCASE LIKE {prefixParameter} ESCAPE '\\')")
            |> String.concat " OR "
            |> fun clause -> "(" + clause + ")")
        |> String.concat " OR "
        |> Some

let private sqliteValueSetPredicate (command: SqliteCommand) parameterPrefix (values: string list) column =
    if values.IsEmpty then None
    else
        values
        |> List.mapi (fun index value ->
            let parameter = $"${parameterPrefix}{index}"
            addParameter command parameter (box value)
            parameter)
        |> String.concat ","
        |> fun parameters -> Some($"{column} COLLATE NOCASE IN ({parameters})")

let private combineSqlPredicates predicates =
    let clauses = predicates |> List.choose id
    if clauses.IsEmpty then "" else " WHERE " + String.concat " AND " clauses

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
        let knowledgeSchemaVersion =
            match Int32.TryParse(getMetadata "schema_version" "0") with
            | true, value -> value
            | _ -> 0
        let eventFactsKnownExpression = if knowledgeSchemaVersion >= 3 then "facts_known" else "0"
        let eventEntryStatusExpression =
            "CASE WHEN " + eventFactsKnownExpression + " = 0 THEN 'unknown' "
            + "WHEN is_triggered_only <> 0 THEN 'triggered_only' "
            + "WHEN has_mtth <> 0 THEN 'mtth_present' "
            + "WHEN EXISTS (SELECT 1 FROM event_edges entry_edge WHERE entry_edge.target_event_id = event_nodes.event_id COLLATE NOCASE AND entry_edge.source_kind <> 'event') THEN 'external_reference' "
            + "WHEN EXISTS (SELECT 1 FROM event_edges entry_edge WHERE entry_edge.target_event_id = event_nodes.event_id COLLATE NOCASE) THEN 'referenced' "
            + "ELSE 'unknown' END"
        let eventHasIndexedCallerExpression =
            "EXISTS (SELECT 1 FROM event_edges caller_edge WHERE caller_edge.target_event_id = event_nodes.event_id COLLATE NOCASE)"
        let incomingCoverage =
            if (getMetadata "topology_truncated" "false").Equals("true", StringComparison.OrdinalIgnoreCase)
            then "partial"
            else "complete"
        let limit = clamp 1 300 options.limit
        let tokens = queryTokens options
        let identifiers = queryIdentifiers options
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
        let evidenceKeys = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        let seedDefinitionRanges = ResizeArray<string * int * int>()
        use definitionCommand = connection.CreateCommand()
        let definitionSearchPredicate =
            if identifiers.IsEmpty then
                sqliteTokenPredicate definitionCommand tokens [ "symbol_id"; "entity_type"; "file_path"; "logical_path"; "domain" ]
            else
                sqliteIndexedIdentifierPredicate definitionCommand "definitionId" identifiers [ "symbol_id" ]
        let definitionDomainPredicate = sqliteValueSetPredicate definitionCommand "definitionDomain" requestedDomains "domain"
        let definitionTypePredicate =
            options.entityTypes
            |> List.map (fun value -> value.Trim().ToLowerInvariant())
            |> List.filter (String.IsNullOrWhiteSpace >> not)
            |> List.distinct
            |> fun values -> sqliteIndexedIdentifierPredicate definitionCommand "definitionType" values [ "entity_type" ]
        let definitionOriginPredicate =
            match options.includeProjectPatterns, options.includeVanillaArchetypes with
            | true, true -> None
            | true, false -> Some("origin = 'workspace'")
            | false, true -> Some("origin = 'vanilla'")
            | false, false -> Some("0 = 1")
        let definitionWhere =
            combineSqlPredicates [ definitionSearchPredicate; definitionDomainPredicate; definitionTypePredicate; definitionOriginPredicate ]
        definitionCommand.CommandText <- "SELECT id, symbol_id, entity_type, file_path, logical_path, line, end_line, origin, validate, overwrite_state, resource_scope, domain, override_path, override_strategy FROM definitions" + definitionWhere + " ORDER BY CASE origin WHEN 'workspace' THEN 0 ELSE 1 END, symbol_id LIMIT $limit"
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
                let line = int (definitionReader.GetInt64 5)
                let endLine = int (definitionReader.GetInt64 6)
                // CWTools may expose the same source definition through several
                // subtype keys. Return one source fact so graph seeds stay diverse.
                let key = $"definition|{symbolId}|{file}|{line}"
                if evidenceKeys.Add key then
                    evidence.Add(
                        jsonRecord
                            [ Some("kind", JsonValue.String "definition")
                              Some("id", JsonValue.String symbolId)
                              Some("entityType", JsonValue.String entityType)
                              Some("file", JsonValue.String file)
                              Some("logicalPath", JsonValue.String logicalPath)
                              Some("line", JsonValue.Number(decimal line))
                              Some("endLine", JsonValue.Number(decimal endLine))
                              Some("origin", JsonValue.String origin)
                              Some("validate", JsonValue.Boolean(definitionReader.GetInt64 8 <> 0L))
                              Some("overwrite", JsonValue.String(definitionReader.GetString 9))
                              stringOrNone definitionReader 10 |> Option.map (fun value -> "resourceScope", JsonValue.String value)
                              Some("domain", JsonValue.String domain)
                              stringOrNone definitionReader 12 |> Option.map (fun value -> "overridePath", JsonValue.String value)
                              stringOrNone definitionReader 13 |> Option.map (fun value -> "overrideStrategy", JsonValue.String value) ])
                    if not identifiers.IsEmpty && seedDefinitionRanges.Count < 40 then
                        seedDefinitionRanges.Add(file, line, endLine)
        definitionReader.Close()

        if options.includeTopology && evidence.Count < limit then
            let addReferenceRow (reader: SqliteDataReader) graphExpansion =
                let sourceFile = reader.GetString 0
                let sourceLogicalPath = reader.GetString 1
                let targetId = reader.GetString 2
                let typeGroup = reader.GetString 3
                let line = int (reader.GetInt64 4)
                let domain = reader.GetString 9
                let isOutgoing = reader.GetInt64 5 <> 0L
                let key = $"reference|{sourceFile}|{line}|{targetId}|{typeGroup}"
                if evidence.Count < limit
                   && allowedDomain domain
                   && (graphExpansion || matchesTokens tokens [ sourceFile; sourceLogicalPath; targetId; typeGroup; domain ])
                   && evidenceKeys.Add key then
                    evidence.Add(
                        jsonRecord
                            [ Some("kind", JsonValue.String "reference")
                              Some("sourceFile", JsonValue.String sourceFile)
                              Some("sourceLogicalPath", JsonValue.String sourceLogicalPath)
                              Some("targetId", JsonValue.String targetId)
                              Some("typeGroup", JsonValue.String typeGroup)
                              Some("line", JsonValue.Number(decimal line))
                              Some("isOutgoing", JsonValue.Boolean isOutgoing)
                              Some("direction", JsonValue.String(if isOutgoing then "source_to_target" else "target_to_source"))
                              Some("causality", JsonValue.String "typed_reference_only")
                              Some("referenceType", JsonValue.String(reader.GetString 6))
                              stringOrNone reader 7 |> Option.map (fun value -> "label", JsonValue.String value)
                              stringOrNone reader 8 |> Option.map (fun value -> "associatedType", JsonValue.String value)
                              Some("domain", JsonValue.String domain)
                              Some("retrieval", JsonValue.String(if graphExpansion then "indexed_outgoing_graph" else if identifiers.IsEmpty then "token_match" else "indexed_incoming_graph")) ])

            use referenceCommand = connection.CreateCommand()
            let referenceSearchPredicate =
                if identifiers.IsEmpty then
                    sqliteTokenPredicate referenceCommand tokens [ "source_file"; "source_logical_path"; "target_id"; "type_group"; "label"; "associated_type"; "domain" ]
                else
                    sqliteIndexedIdentifierPredicate referenceCommand "referenceTarget" identifiers [ "target_id" ]
            let referenceDomainPredicate = sqliteValueSetPredicate referenceCommand "referenceDomain" requestedDomains "domain"
            let referenceTypePredicate =
                options.entityTypes
                |> List.map (fun value -> value.Trim().ToLowerInvariant())
                |> List.filter (String.IsNullOrWhiteSpace >> not)
                |> List.distinct
                |> fun values -> sqliteIndexedIdentifierPredicate referenceCommand "referenceType" values [ "type_group"; "associated_type" ]
            let referenceWhere = combineSqlPredicates [ referenceSearchPredicate; referenceDomainPredicate; referenceTypePredicate ]
            referenceCommand.CommandText <- "SELECT source_file, source_logical_path, target_id, type_group, line, is_outgoing, reference_type, label, associated_type, domain FROM references_graph" + referenceWhere + " LIMIT $limit"
            addParameter referenceCommand "$limit" (box (max 500 (limit * 20)))
            use referenceReader = referenceCommand.ExecuteReader()
            while referenceReader.Read() && evidence.Count < limit do
                addReferenceRow referenceReader false
            referenceReader.Close()

            if not identifiers.IsEmpty && evidence.Count < limit then
                use outgoingReferenceCommand = connection.CreateCommand()
                outgoingReferenceCommand.CommandText <-
                    "SELECT source_file, source_logical_path, target_id, type_group, line, is_outgoing, reference_type, label, associated_type, domain FROM references_graph WHERE source_file = $sourceFile AND line BETWEEN $startLine AND $endLine ORDER BY line LIMIT $limit"
                prepareCommandParameters outgoingReferenceCommand
                    [ "$sourceFile", box ""; "$startLine", box 0; "$endLine", box 0; "$limit", box limit ]
                for sourceFile, startLine, endLine in seedDefinitionRanges do
                    if evidence.Count < limit then
                        setPreparedCommandParameters outgoingReferenceCommand
                            [ "$sourceFile", box sourceFile; "$startLine", box startLine; "$endLine", box endLine; "$limit", box (limit - evidence.Count) ]
                        use outgoingReader = outgoingReferenceCommand.ExecuteReader()
                        while outgoingReader.Read() && evidence.Count < limit do
                            addReferenceRow outgoingReader true

        let eventNodes = ResizeArray<JsonValue>()
        let eventEdges = ResizeArray<JsonValue>()
        let eventLogic = ResizeArray<JsonValue>()
        let returnedNodeIds = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        let relatedEventIds = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        let logicSubjects = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        let returnedLogicKeys = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        if options.includeEventGraph then
            use nodeCommand = connection.CreateCommand()
            let nodeSearchPredicate =
                if identifiers.IsEmpty then
                    sqliteTokenPredicate nodeCommand tokens [ "event_id"; "event_type"; "title"; "file_path"; "logical_path" ]
                else
                    sqliteIndexedIdentifierPredicate nodeCommand "eventNode" identifiers [ "event_id" ]
            nodeCommand.CommandText <-
                "SELECT event_id, event_type, title, file_path, logical_path, line, end_line, origin, is_triggered_only, is_hidden, has_mtth, "
                + eventFactsKnownExpression + ", " + eventEntryStatusExpression + ", " + eventHasIndexedCallerExpression
                + " FROM event_nodes" + combineSqlPredicates [ nodeSearchPredicate ] + " LIMIT $limit"
            addParameter nodeCommand "$limit" (box (max 200 (limit * 10)))
            use nodeReader = nodeCommand.ExecuteReader()
            while nodeReader.Read() && eventNodes.Count < limit do
                let eventId = nodeReader.GetString 0
                let eventType = nodeReader.GetString 1
                let file = nodeReader.GetString 3
                if matchesTokens tokens [ eventId; eventType; file; stringOrNone nodeReader 2 |> Option.defaultValue "" ] then
                    let factsKnown = nodeReader.GetInt64 11 <> 0L
                    returnedNodeIds.Add eventId |> ignore
                    eventNodes.Add(
                        jsonRecord
                            [ Some("eventId", JsonValue.String eventId); Some("eventType", JsonValue.String eventType)
                              stringOrNone nodeReader 2 |> Option.map (fun value -> "title", JsonValue.String value)
                              Some("file", JsonValue.String file); Some("logicalPath", JsonValue.String(nodeReader.GetString 4))
                              Some("line", JsonValue.Number(decimal (nodeReader.GetInt64 5))); Some("endLine", JsonValue.Number(decimal (nodeReader.GetInt64 6)))
                              Some("origin", JsonValue.String(nodeReader.GetString 7)); Some("factsKnown", JsonValue.Boolean factsKnown)
                              (if factsKnown then Some("isTriggeredOnly", JsonValue.Boolean(nodeReader.GetInt64 8 <> 0L)) else None)
                              (if factsKnown then Some("isHidden", JsonValue.Boolean(nodeReader.GetInt64 9 <> 0L)) else None)
                              (if factsKnown then Some("hasMeanTimeToHappen", JsonValue.Boolean(nodeReader.GetInt64 10 <> 0L)) else None)
                              Some("entryStatus", JsonValue.String(nodeReader.GetString 12))
                              Some("hasIndexedCaller", JsonValue.Boolean(nodeReader.GetInt64 13 <> 0L))
                              Some("incomingCoverage", JsonValue.String incomingCoverage) ])
            nodeReader.Close()
            use edgeCommand = connection.CreateCommand()
            let edgeSearchPredicate =
                if identifiers.IsEmpty then
                    sqliteTokenPredicate edgeCommand tokens [ "source_kind"; "source_id"; "target_event_id"; "edge_type"; "label"; "source_file" ]
                else
                    sqliteIndexedIdentifierPredicate edgeCommand "eventEdge" identifiers [ "source_id"; "target_event_id" ]
            edgeCommand.CommandText <- "SELECT source_kind, source_id, target_event_id, edge_type, label, source_file, line, confidence FROM event_edges" + combineSqlPredicates [ edgeSearchPredicate ] + " LIMIT $limit"
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
                              Some("direction", JsonValue.String "source_to_target")
                              Some("causality", JsonValue.String "directed_typed_reference")
                              stringOrNone edgeReader 4 |> Option.map (fun value -> "label", JsonValue.String value)
                              Some("sourceFile", JsonValue.String(edgeReader.GetString 5)); Some("line", JsonValue.Number(decimal (edgeReader.GetInt64 6)))
                              Some("confidence", JsonValue.String(edgeReader.GetString 7)) ])
            edgeReader.Close()
            use logicCommand = connection.CreateCommand()
            let logicSearchPredicate =
                if identifiers.IsEmpty then
                    sqliteTokenPredicate logicCommand tokens [ "event_id"; "relation_type"; "subject"; "scope"; "phase"; "source_file"; "details" ]
                else
                    sqliteIndexedIdentifierPredicate logicCommand "eventLogic" identifiers [ "event_id"; "subject" ]
            logicCommand.CommandText <- "SELECT event_id, relation_type, subject, scope, phase, source_file, line, details FROM event_logic" + combineSqlPredicates [ logicSearchPredicate ] + " LIMIT $limit"
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
                    "SELECT event_id, event_type, title, file_path, logical_path, line, end_line, origin, is_triggered_only, is_hidden, has_mtth, "
                    + eventFactsKnownExpression + ", " + eventEntryStatusExpression + ", " + eventHasIndexedCallerExpression
                    + " FROM event_nodes WHERE event_id COLLATE NOCASE IN ("
                    + String.concat "," nodeParameters
                    + ") LIMIT $limit"
                addParameter relatedNodeCommand "$limit" (box limit)
                use relatedNodeReader = relatedNodeCommand.ExecuteReader()
                while relatedNodeReader.Read() && eventNodes.Count < limit do
                    let eventId = relatedNodeReader.GetString 0
                    if returnedNodeIds.Add eventId then
                        let factsKnown = relatedNodeReader.GetInt64 11 <> 0L
                        eventNodes.Add(
                            jsonRecord
                                [ Some("eventId", JsonValue.String eventId); Some("eventType", JsonValue.String(relatedNodeReader.GetString 1))
                                  stringOrNone relatedNodeReader 2 |> Option.map (fun value -> "title", JsonValue.String value)
                                  Some("file", JsonValue.String(relatedNodeReader.GetString 3)); Some("logicalPath", JsonValue.String(relatedNodeReader.GetString 4))
                                  Some("line", JsonValue.Number(decimal (relatedNodeReader.GetInt64 5))); Some("endLine", JsonValue.Number(decimal (relatedNodeReader.GetInt64 6)))
                                  Some("origin", JsonValue.String(relatedNodeReader.GetString 7)); Some("factsKnown", JsonValue.Boolean factsKnown)
                                  (if factsKnown then Some("isTriggeredOnly", JsonValue.Boolean(relatedNodeReader.GetInt64 8 <> 0L)) else None)
                                  (if factsKnown then Some("isHidden", JsonValue.Boolean(relatedNodeReader.GetInt64 9 <> 0L)) else None)
                                  (if factsKnown then Some("hasMeanTimeToHappen", JsonValue.Boolean(relatedNodeReader.GetInt64 10 <> 0L)) else None)
                                  Some("entryStatus", JsonValue.String(relatedNodeReader.GetString 12))
                                  Some("hasIndexedCaller", JsonValue.Boolean(relatedNodeReader.GetInt64 13 <> 0L))
                                  Some("incomingCoverage", JsonValue.String incomingCoverage) ])

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
              Some("schemaVersion", JsonValue.Number(decimal knowledgeSchemaVersion))
              Some("databasePath", JsonValue.String(normalizePath databasePath))
              Some("generatedAt", JsonValue.String(getMetadata "generated_at" ""))
              Some("game", JsonValue.String(getMetadata "game" "unknown"))
              Some("graphVersion", JsonValue.Number(decimal (Int64.Parse(getMetadata "graph_version" "0"))))
              Some("retrieval", jsonRecord
                [ Some("strategy", JsonValue.String(if identifiers.IsEmpty then "bounded_token_scan" else "indexed_graph"))
                  Some("seedIdentifiers", jsonStringArray identifiers)
                  Some("seedDefinitions", JsonValue.Number(decimal seedDefinitionRanges.Count))
                  Some("evidenceReturned", JsonValue.Number(decimal evidence.Count))
                  Some("eventNodesReturned", JsonValue.Number(decimal eventNodes.Count))
                  Some("eventEdgesReturned", JsonValue.Number(decimal eventEdges.Count))
                  Some("eventLogicReturned", JsonValue.Number(decimal eventLogic.Count)) ])
              Some("domains", jsonStringArray (capabilities |> Seq.map (fun item -> item.GetProperty("domain").AsString())))
              Some("capabilities", JsonValue.Array(capabilities.ToArray()))
              Some("evidence", JsonValue.Array(evidence.ToArray()))
              Some("eventGraph", jsonRecord
                [ Some("nodes", JsonValue.Array(eventNodes.ToArray()))
                  Some("edges", JsonValue.Array(eventEdges.ToArray()))
                  Some("logic", JsonValue.Array(eventLogic.ToArray()))
                  Some("incomingCoverage", JsonValue.String incomingCoverage)
                  Some("causalityPolicy", JsonValue.String "Only directed typed references and explicit execution facts are evidence; IDs, source order, layout, and missing edges are not.") ])
              Some("unresolved", JsonValue.Array(unresolved.ToArray()))
              Some("requiredNextChecks", jsonStringArray
                [ "Use query_cwt_schema/query_rules/query_scope for legality before writing."
                  "For shader evidence, use query_shader_compile_unit/query_shader_callers/explain_shader_reachability before editing."
                  "For interface shaders, trace gui_uses_interface_sprite -> interface_sprite_selects_shader_file and verify renderer inputs/subtype before editing effectFile or Effect names."
                  "Read exact source blocks referenced by event structure and logic evidence."
                  "Verify event scope bridges and state lifecycles before approving complex blueprints."
                  "Never infer event or entity causality from numeric IDs, file/source order, proximity, graph layout, or a missing incoming edge." ]) ]

let private exportProjectKnowledgeRebuild (activeGame: string) (projectRoots: string list) (rawOptions: ExportOptions) (runtime: RuntimeMetadata) (game: IGame<'T>) =
    let normalizedOptions = normalizeOptions rawOptions
    let shaderRelevantFile (file: string) =
        match Path.GetExtension(file).ToLowerInvariant() with
        | ".shader"
        | ".fxh"
        | ".gfx"
        | ".asset"
        | ".gui" -> true
        | _ -> false
    let boundedRequestedOptions =
        { normalizedOptions with
            changedFiles = normalizedOptions.changedFiles |> List.filter (fun file -> projectRoots |> List.exists (fun root -> pathInside root file)) }
    // Shader resolution is graph-wide: adding/removing a file can change Include
    // ambiguity, effectFile suffix resolution and GUI-to-sprite edges originating
    // in otherwise unchanged files. Invalidate the complete Shader domain whenever
    // one of its source classes changes.
    let requestedOptions =
        if activeGame.Equals("stellaris", StringComparison.OrdinalIgnoreCase)
           && boundedRequestedOptions.changedFiles |> List.exists shaderRelevantFile then
            { boundedRequestedOptions with domains = "shader" :: boundedRequestedOptions.domains |> List.distinct }
        else
            boundedRequestedOptions
    let incrementalBase =
        match requestedOptions.databasePath with
        | Some databasePath when requestedOptions.generationMode = "incremental" && (not requestedOptions.domains.IsEmpty || not requestedOptions.changedFiles.IsEmpty) ->
            readRetainedKnowledgeDatabase databasePath requestedOptions.domains requestedOptions.changedFiles
        | _ -> None
    let collectionOptions =
        match requestedOptions.databasePath, incrementalBase with
        | Some _, None -> { requestedOptions with domains = []; changedFiles = []; generationMode = "full" }
        | _ -> requestedOptions
    let resources = resourceFacts (game :> IGame)
    let shaderRefreshRequired =
        match incrementalBase with
        | None -> true
        | Some _ ->
            collectionOptions.domains |> List.contains "shader"
            || collectionOptions.changedFiles |> List.exists shaderRelevantFile
    let shaderModel =
        if activeGame.Equals("stellaris", StringComparison.OrdinalIgnoreCase) && shaderRefreshRequired then
            Some(PdxShaderRuntime.buildModel None (game.AllFiles()) [])
        else
            None
    let freshDefinitions = collectDefinitions (game :> IGame) projectRoots resources shaderModel collectionOptions
    let freshTopology = collectTopology projectRoots collectionOptions shaderModel game
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
    // only the changed files/domains are re-extracted, while retained rows are loaded
    // from the previous V2 database before stacks and event relationships rebuild.
    let options = { collectionOptions with domains = []; changedFiles = []; generationMode = generationMode }
    let definitions = selectDefinitions options availableDefinitions
    let domains = domainSummaries options definitions
    let eventGraph = collectEventGraph options availableDefinitions topology game
    let warnings = ResizeArray<string>()
    if runtime.status <> "ready" then warnings.Add("The knowledge snapshot was exported while CWTools was loading or stale.")
    if topology.truncated then warnings.Add("Topology and event relationships are partial because the configured export limits were reached.")
    if definitions.Length < availableDefinitions.Length then
        warnings.Add("Definitions were sampled by maxDefinitions; workspace and event-core definitions were preserved.")
    if definitions |> List.exists (fun item -> item.origin = "vanilla") |> not then warnings.Add("No vanilla definitions were detected in the loaded game model.")

    let publishedRuntime =
        if runtime.status = "ready" && topology.truncated then { runtime with status = "partial" }
        else runtime

    match options.databasePath with
    | Some databasePath ->
        let storedPath, generatedAt =
            writeKnowledgeDatabase databasePath activeGame projectRoots options publishedRuntime definitions topology eventGraph (game :> IGame) warnings
        jsonRecord
            [ Some("ok", JsonValue.Boolean true)
              Some("status", JsonValue.String publishedRuntime.status)
              Some("source", JsonValue.String "cwtools-project-knowledge-sqlite")
              Some("schemaVersion", JsonValue.Number 3m)
              Some("game", JsonValue.String activeGame)
              Some("generatedAtUnixMs", JsonValue.Number(decimal (generatedAt.ToUnixTimeMilliseconds())))
              Some("graphVersion", JsonValue.Number(decimal runtime.graphVersion))
              Some("completeExport", JsonValue.Boolean options.completeExport)
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
              Some("completeExport", JsonValue.Boolean options.completeExport)
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

let private databaseWriteGates = ConcurrentDictionary<string, obj>(StringComparer.OrdinalIgnoreCase)

let private incrementalExportError status message =
    jsonRecord
        [ Some("ok", JsonValue.Boolean false)
          Some("status", JsonValue.String status)
          Some("error", JsonValue.String message) ]

let private tryIncrementalProjectKnowledgeExport
    (activeGame: string)
    (projectRoots: string list)
    (rawOptions: ExportOptions)
    (runtime: RuntimeMetadata)
    (game: IGame<'T>)
    =
    let options = normalizeOptions rawOptions
    if options.generationMode <> "incremental" then None
    else
        match options.databasePath with
        | None -> None
        | Some databasePath ->
            let changedFiles =
                options.changedFiles
                |> List.filter (fun file -> projectRoots |> List.exists (fun root -> pathInside root file))
            let shaderRelevantFile (file: string) =
                match Path.GetExtension(file).ToLowerInvariant() with
                | ".shader"
                | ".fxh"
                | ".gfx"
                | ".asset"
                | ".gui" -> true
                | _ -> false
            if changedFiles.IsEmpty then
                Some(incrementalExportError "stale" "No changed project files were supplied for the incremental update.")
            elif not options.domains.IsEmpty || changedFiles |> List.exists shaderRelevantFile then
                Some(incrementalExportError "stale" "This change affects graph-wide project knowledge and will be rebuilt on the next project load.")
            elif not (File.Exists databasePath) then
                Some(incrementalExportError "missing" "The project knowledge database is missing; reload the project to rebuild it.")
            else
                let target = Path.GetFullPath databasePath
                if not (isKnowledgeDatabasePathAllowed projectRoots target) then
                    Some(incrementalExportError "error" "Project knowledge database must be inside a project root.")
                else
                    let collectionOptions =
                        { options with
                            domains = []
                            changedFiles = changedFiles
                            generationMode = "incremental" }
                    let resources = resourceFacts (game :> IGame)
                    let freshDefinitions = collectDefinitions (game :> IGame) projectRoots resources None collectionOptions
                    let freshTopology = collectTopology projectRoots collectionOptions None game
                    let connectionString =
                        SqliteConnectionStringBuilder(
                            DataSource = target,
                            Mode = SqliteOpenMode.ReadWrite,
                            Pooling = false
                        ).ToString()
                    use connection = new SqliteConnection(connectionString)
                    connection.Open()
                    executeSql connection None "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;"
                    let metadata = readMetadata connection
                    let schemaVersion =
                        match metadata.TryGetValue "schema_version" with
                        | true, value -> value
                        | _ -> ""
                    if schemaVersion <> "3" then
                        Some(incrementalExportError "stale" "The project knowledge schema changed; reload the project to rebuild it.")
                    else
                        let knownEventIds =
                            use command = connection.CreateCommand()
                            command.CommandText <- "SELECT DISTINCT lower(symbol_id) FROM definitions WHERE entity_type = 'event' COLLATE NOCASE"
                            use reader = command.ExecuteReader()
                            let values = ResizeArray<string>()
                            while reader.Read() do values.Add(reader.GetString 0)
                            values |> Set.ofSeq
                        let eventGraph =
                            collectEventGraphWithKnownIds knownEventIds collectionOptions freshDefinitions freshTopology game
                        use transaction = connection.BeginTransaction()
                        executeSql connection (Some transaction) """
CREATE TEMP TABLE changed_paths(path TEXT PRIMARY KEY);
CREATE TEMP TABLE affected_symbols(
  entity_type_key TEXT NOT NULL,
  symbol_id_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  PRIMARY KEY(entity_type_key, symbol_id_key)
);
CREATE TEMP TABLE affected_domains(domain TEXT PRIMARY KEY);
CREATE TEMP TABLE affected_event_ids(event_id TEXT PRIMARY KEY);
CREATE TEMP TABLE fresh_event_ids(event_id TEXT PRIMARY KEY);
"""
                        use changedPathCommand = connection.CreateCommand()
                        changedPathCommand.Transaction <- transaction
                        changedPathCommand.CommandText <- "INSERT OR IGNORE INTO changed_paths(path) VALUES ($path)"
                        prepareCommandParameters changedPathCommand [ "$path", box "" ]
                        for file in changedFiles do
                            setPreparedCommandParameters changedPathCommand [ "$path", box file ]
                            changedPathCommand.ExecuteNonQuery() |> ignore

                        let pathComparison =
                            if OperatingSystem.IsWindows() then "COLLATE NOCASE" else "COLLATE BINARY"
                        executeSql connection (Some transaction) $"""
INSERT OR IGNORE INTO affected_symbols(entity_type_key, symbol_id_key, entity_type, symbol_id)
SELECT lower(d.entity_type), lower(d.symbol_id), d.entity_type, d.symbol_id
FROM definitions d JOIN changed_paths c ON d.file_path = c.path {pathComparison};
INSERT OR IGNORE INTO affected_domains(domain)
SELECT d.domain FROM definitions d JOIN changed_paths c ON d.file_path = c.path {pathComparison};
INSERT OR IGNORE INTO affected_domains(domain)
SELECT f.domain FROM files f JOIN changed_paths c ON f.path = c.path {pathComparison};
INSERT OR IGNORE INTO affected_domains(domain)
SELECT r.domain FROM references_graph r JOIN changed_paths c ON r.source_file = c.path {pathComparison};
INSERT OR IGNORE INTO affected_event_ids(event_id)
SELECT lower(d.symbol_id)
FROM definitions d JOIN changed_paths c ON d.file_path = c.path {pathComparison}
WHERE lower(d.entity_type) = 'event';
"""
                        use affectedSymbolCommand = connection.CreateCommand()
                        affectedSymbolCommand.Transaction <- transaction
                        affectedSymbolCommand.CommandText <- "INSERT OR IGNORE INTO affected_symbols(entity_type_key, symbol_id_key, entity_type, symbol_id) VALUES ($typeKey, $symbolKey, $type, $symbol)"
                        prepareCommandParameters affectedSymbolCommand
                            [ "$typeKey", box ""; "$symbolKey", box ""; "$type", box ""; "$symbol", box "" ]
                        use affectedDomainCommand = connection.CreateCommand()
                        affectedDomainCommand.Transaction <- transaction
                        affectedDomainCommand.CommandText <- "INSERT OR IGNORE INTO affected_domains(domain) VALUES ($domain)"
                        prepareCommandParameters affectedDomainCommand [ "$domain", box "" ]
                        use freshEventIdCommand = connection.CreateCommand()
                        freshEventIdCommand.Transaction <- transaction
                        freshEventIdCommand.CommandText <- "INSERT OR IGNORE INTO fresh_event_ids(event_id) VALUES ($event)"
                        prepareCommandParameters freshEventIdCommand [ "$event", box "" ]
                        for definition in freshDefinitions do
                            setPreparedCommandParameters affectedSymbolCommand
                                [ "$typeKey", box (definition.entityType.ToLowerInvariant())
                                  "$symbolKey", box (definition.id.ToLowerInvariant())
                                  "$type", box definition.entityType
                                  "$symbol", box definition.id ]
                            affectedSymbolCommand.ExecuteNonQuery() |> ignore
                            setPreparedCommandParameters affectedDomainCommand [ "$domain", box definition.domain ]
                            affectedDomainCommand.ExecuteNonQuery() |> ignore
                            if definition.entityType.Equals("event", StringComparison.OrdinalIgnoreCase) then
                                setPreparedCommandParameters freshEventIdCommand [ "$event", box (definition.id.ToLowerInvariant()) ]
                                freshEventIdCommand.ExecuteNonQuery() |> ignore
                        for file in freshTopology.files do
                            setPreparedCommandParameters affectedDomainCommand [ "$domain", box file.domain ]
                            affectedDomainCommand.ExecuteNonQuery() |> ignore

                        executeSql connection (Some transaction) $"""
DELETE FROM definition_stacks
WHERE EXISTS (
  SELECT 1 FROM affected_symbols a
  WHERE lower(definition_stacks.entity_type) = a.entity_type_key
    AND lower(definition_stacks.symbol_id) = a.symbol_id_key
);
DELETE FROM unresolved
WHERE kind = 'definition_resolution'
  AND EXISTS (
    SELECT 1 FROM affected_symbols a
    WHERE lower(coalesce(unresolved.entity_type, '')) = a.entity_type_key
      AND lower(coalesce(unresolved.symbol_id, '')) = a.symbol_id_key
  );
DELETE FROM event_edges
WHERE EXISTS (SELECT 1 FROM changed_paths c WHERE event_edges.source_file = c.path {pathComparison});
DELETE FROM event_logic
WHERE EXISTS (SELECT 1 FROM changed_paths c WHERE event_logic.source_file = c.path {pathComparison});
DELETE FROM event_nodes
WHERE EXISTS (SELECT 1 FROM changed_paths c WHERE event_nodes.file_path = c.path {pathComparison});
DELETE FROM references_graph
WHERE EXISTS (SELECT 1 FROM changed_paths c WHERE references_graph.source_file = c.path {pathComparison});
DELETE FROM files
WHERE EXISTS (SELECT 1 FROM changed_paths c WHERE files.path = c.path {pathComparison});
DELETE FROM definitions
WHERE EXISTS (SELECT 1 FROM changed_paths c WHERE definitions.file_path = c.path {pathComparison});
DELETE FROM event_edges
WHERE lower(target_event_id) IN (
  SELECT event_id FROM affected_event_ids
  WHERE event_id NOT IN (SELECT event_id FROM fresh_event_ids)
);
"""
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
                        for definition in freshDefinitions do
                            setPreparedCommandParameters definitionCommand
                                [ "$symbol", box definition.id; "$type", box definition.entityType; "$file", box (normalizePath definition.file)
                                  "$logical", box (normalizePath definition.logicalPath); "$line", box definition.line; "$end", box definition.endLine
                                  "$origin", box definition.origin; "$validate", box (if definition.validate then 1 else 0); "$overwrite", box definition.overwrite
                                  "$scope", box (definition.resourceScope |> Option.toObj); "$domain", box definition.domain
                                  "$overridePath", box (definition.overridePath |> Option.toObj); "$overrideStrategy", box (definition.overrideStrategy |> Option.toObj) ]
                            let definitionId = definitionCommand.ExecuteScalar() :?> int64
                            for subtype in definition.subtypes do
                                setPreparedCommandParameters subtypeCommand [ "$definition", box definitionId; "$subtype", box subtype ]
                                subtypeCommand.ExecuteNonQuery() |> ignore

                        use fileCommand = connection.CreateCommand()
                        fileCommand.Transaction <- transaction
                        fileCommand.CommandText <- "INSERT OR REPLACE INTO files(path, logical_path, domain, origin) VALUES ($path, $logical, $domain, $origin)"
                        prepareCommandParameters fileCommand [ "$path", box ""; "$logical", box ""; "$domain", box ""; "$origin", box "" ]
                        for item in freshTopology.files do
                            setPreparedCommandParameters fileCommand
                                [ "$path", box item.file; "$logical", box item.logicalPath; "$domain", box item.domain; "$origin", box item.origin ]
                            fileCommand.ExecuteNonQuery() |> ignore

                        use referenceCommand = connection.CreateCommand()
                        referenceCommand.Transaction <- transaction
                        referenceCommand.CommandText <- "INSERT INTO references_graph(source_file, source_logical_path, target_id, type_group, line, is_outgoing, reference_type, label, associated_type, domain) VALUES ($file, $logical, $target, $group, $line, $outgoing, $referenceType, $label, $associated, $domain)"
                        prepareCommandParameters referenceCommand
                            [ "$file", box ""; "$logical", box ""; "$target", box ""; "$group", box ""; "$line", box 0; "$outgoing", box 0
                              "$referenceType", box ""; "$label", box ""; "$associated", box ""; "$domain", box "" ]
                        for reference in freshTopology.edges do
                            setPreparedCommandParameters referenceCommand
                                [ "$file", box reference.sourceFile; "$logical", box reference.sourceLogicalPath; "$target", box reference.targetId
                                  "$group", box reference.typeGroup; "$line", box reference.line; "$outgoing", box (if reference.isOutgoing then 1 else 0)
                                  "$referenceType", box reference.referenceType; "$label", box (reference.label |> Option.toObj)
                                  "$associated", box (reference.associatedType |> Option.toObj); "$domain", box reference.domain ]
                            referenceCommand.ExecuteNonQuery() |> ignore

                        use eventNodeCommand = connection.CreateCommand()
                        eventNodeCommand.Transaction <- transaction
                        eventNodeCommand.CommandText <- "INSERT INTO event_nodes(event_id, event_type, title, file_path, logical_path, line, end_line, origin, is_triggered_only, is_hidden, has_mtth, facts_known) VALUES ($id, $type, $title, $file, $logical, $line, $end, $origin, $triggered, $hidden, $mtth, $factsKnown)"
                        prepareCommandParameters eventNodeCommand
                            [ "$id", box ""; "$type", box ""; "$title", box ""; "$file", box ""; "$logical", box ""; "$line", box 0
                              "$end", box 0; "$origin", box ""; "$triggered", box 0; "$hidden", box 0; "$mtth", box 0; "$factsKnown", box 0 ]
                        for node in eventGraph.nodes do
                            setPreparedCommandParameters eventNodeCommand
                                [ "$id", box node.eventId; "$type", box node.eventType; "$title", box (node.title |> Option.toObj)
                                  "$file", box node.file; "$logical", box node.logicalPath; "$line", box node.line; "$end", box node.endLine
                                  "$origin", box node.origin; "$triggered", box (if node.isTriggeredOnly then 1 else 0)
                                  "$hidden", box (if node.isHidden then 1 else 0); "$mtth", box (if node.hasMeanTimeToHappen then 1 else 0)
                                  "$factsKnown", box (if node.factsKnown then 1 else 0) ]
                            eventNodeCommand.ExecuteNonQuery() |> ignore
                        use eventEdgeCommand = connection.CreateCommand()
                        eventEdgeCommand.Transaction <- transaction
                        eventEdgeCommand.CommandText <- "INSERT INTO event_edges(source_kind, source_id, target_event_id, edge_type, label, source_file, line, confidence) VALUES ($kind, $source, $target, $type, $label, $file, $line, $confidence)"
                        prepareCommandParameters eventEdgeCommand
                            [ "$kind", box ""; "$source", box ""; "$target", box ""; "$type", box ""; "$label", box ""; "$file", box ""
                              "$line", box 0; "$confidence", box "" ]
                        for edge in eventGraph.edges do
                            setPreparedCommandParameters eventEdgeCommand
                                [ "$kind", box edge.sourceKind; "$source", box edge.sourceId; "$target", box edge.targetEventId
                                  "$type", box edge.edgeType; "$label", box (edge.label |> Option.toObj); "$file", box edge.sourceFile
                                  "$line", box edge.line; "$confidence", box edge.confidence ]
                            eventEdgeCommand.ExecuteNonQuery() |> ignore
                        use eventLogicCommand = connection.CreateCommand()
                        eventLogicCommand.Transaction <- transaction
                        eventLogicCommand.CommandText <- "INSERT INTO event_logic(event_id, relation_type, subject, scope, phase, source_file, line, details) VALUES ($event, $type, $subject, $scope, $phase, $file, $line, $details)"
                        prepareCommandParameters eventLogicCommand
                            [ "$event", box ""; "$type", box ""; "$subject", box ""; "$scope", box ""; "$phase", box ""; "$file", box ""
                              "$line", box 0; "$details", box "" ]
                        for item in eventGraph.logic do
                            setPreparedCommandParameters eventLogicCommand
                                [ "$event", box item.eventId; "$type", box item.relationType; "$subject", box item.subject
                                  "$scope", box (item.scope |> Option.toObj); "$phase", box item.phase; "$file", box item.sourceFile
                                  "$line", box item.line; "$details", box (item.details |> Option.toObj) ]
                            eventLogicCommand.ExecuteNonQuery() |> ignore

                        let affectedDefinitionRows =
                            use command = connection.CreateCommand()
                            command.Transaction <- transaction
                            command.CommandText <- """
SELECT d.id, d.entity_type, d.symbol_id, d.overwrite_state, d.override_strategy
FROM definitions d
JOIN affected_symbols a
  ON d.entity_type = a.entity_type_key COLLATE NOCASE
 AND d.symbol_id = a.symbol_id_key COLLATE NOCASE
ORDER BY lower(d.entity_type), lower(d.symbol_id), d.id
"""
                            use reader = command.ExecuteReader()
                            let rows = ResizeArray<int64 * string * string * string * string option>()
                            while reader.Read() do
                                rows.Add(
                                    reader.GetInt64 0,
                                    reader.GetString 1,
                                    reader.GetString 2,
                                    reader.GetString 3,
                                    stringOrNone reader 4)
                            rows |> Seq.toList
                        use stackCommand = connection.CreateCommand()
                        stackCommand.Transaction <- transaction
                        stackCommand.CommandText <- "INSERT INTO definition_stacks(entity_type, symbol_id, resolution) VALUES ($type, $symbol, $resolution) RETURNING id"
                        use candidateCommand = connection.CreateCommand()
                        candidateCommand.Transaction <- transaction
                        candidateCommand.CommandText <- "INSERT INTO stack_candidates(stack_id, definition_id, is_active) VALUES ($stack, $definition, $active)"
                        use unresolvedCommand = connection.CreateCommand()
                        unresolvedCommand.Transaction <- transaction
                        unresolvedCommand.CommandText <- "INSERT INTO unresolved(kind, entity_type, symbol_id, resolution, message) VALUES ('definition_resolution', $type, $symbol, $resolution, 'The effective definition requires override-mode or ambiguity review.')"
                        for _, values in affectedDefinitionRows |> Seq.groupBy (fun (_, entityType, symbolId, _, _) -> entityType.ToLowerInvariant(), symbolId.ToLowerInvariant()) do
                            let items = values |> Seq.toList
                            if items.Length > 1 then
                                let _, entityType, symbolId, _, _ = items.Head
                                let active = items |> List.filter (fun (_, _, _, overwrite, _) -> overwrite <> "overwritten")
                                let resolution =
                                    if active.Length = 1 then "single_active_definition"
                                    elif items |> List.exists (fun (_, _, _, _, strategy) -> strategy.IsSome) then "consult_override_mode"
                                    else "ambiguous"
                                setCommandParameters stackCommand [ "$type", box entityType; "$symbol", box symbolId; "$resolution", box resolution ]
                                let stackId = stackCommand.ExecuteScalar() :?> int64
                                for definitionId, _, _, overwrite, _ in items do
                                    setCommandParameters candidateCommand
                                        [ "$stack", box stackId; "$definition", box definitionId
                                          "$active", box (if overwrite <> "overwritten" then 1 else 0) ]
                                    candidateCommand.ExecuteNonQuery() |> ignore
                                if resolution <> "single_active_definition" then
                                    setCommandParameters unresolvedCommand
                                        [ "$type", box entityType; "$symbol", box symbolId; "$resolution", box resolution ]
                                    unresolvedCommand.ExecuteNonQuery() |> ignore

                        let affectedDomains =
                            use command = connection.CreateCommand()
                            command.Transaction <- transaction
                            command.CommandText <- "SELECT domain FROM affected_domains ORDER BY domain"
                            use reader = command.ExecuteReader()
                            let values = ResizeArray<string>()
                            while reader.Read() do values.Add(reader.GetString 0)
                            values |> Seq.toList
                        use deleteDomainCommand = connection.CreateCommand()
                        deleteDomainCommand.Transaction <- transaction
                        deleteDomainCommand.CommandText <- "DELETE FROM domains WHERE id = $domain"
                        use deleteArchetypesCommand = connection.CreateCommand()
                        deleteArchetypesCommand.Transaction <- transaction
                        deleteArchetypesCommand.CommandText <- "DELETE FROM archetypes WHERE domain = $domain"
                        use insertDomainCommand = connection.CreateCommand()
                        insertDomainCommand.Transaction <- transaction
                        insertDomainCommand.CommandText <- "INSERT INTO domains(id, definition_count, workspace_count, vanilla_count, entity_types_json, directories_json) VALUES ($id, $count, $workspace, $vanilla, $types, $directories)"
                        use insertArchetypeCommand = connection.CreateCommand()
                        insertArchetypeCommand.Transaction <- transaction
                        insertArchetypeCommand.CommandText <- "INSERT OR IGNORE INTO archetypes(definition_id, domain, origin, rank, role) VALUES ($definition, $domain, $origin, $rank, $role)"
                        for domain in affectedDomains do
                            setCommandParameters deleteDomainCommand [ "$domain", box domain ]
                            deleteDomainCommand.ExecuteNonQuery() |> ignore
                            setCommandParameters deleteArchetypesCommand [ "$domain", box domain ]
                            deleteArchetypesCommand.ExecuteNonQuery() |> ignore
                            let domainDefinitions =
                                use command = connection.CreateCommand()
                                command.Transaction <- transaction
                                command.CommandText <- "SELECT id, entity_type, logical_path, origin FROM definitions WHERE domain = $domain ORDER BY entity_type, symbol_id, origin, file_path, line"
                                addParameter command "$domain" (box domain)
                                use reader = command.ExecuteReader()
                                let rows = ResizeArray<int64 * string * string * string>()
                                while reader.Read() do
                                    rows.Add(reader.GetInt64 0, reader.GetString 1, reader.GetString 2, reader.GetString 3)
                                rows |> Seq.toList
                            let topologyFileCount =
                                use command = connection.CreateCommand()
                                command.Transaction <- transaction
                                command.CommandText <- "SELECT count(*) FROM files WHERE domain = $domain"
                                addParameter command "$domain" (box domain)
                                Convert.ToInt32(command.ExecuteScalar())
                            if not domainDefinitions.IsEmpty || topologyFileCount > 0 then
                                let entityTypes =
                                    domainDefinitions
                                    |> Seq.map (fun (_, entityType, _, _) -> entityType)
                                    |> Seq.distinct
                                    |> Seq.sort
                                    |> Seq.map JsonValue.String
                                    |> Seq.toArray
                                    |> JsonValue.Array
                                let directories =
                                    domainDefinitions
                                    |> Seq.choose (fun (_, _, logicalPath, _) ->
                                        let directory = Path.GetDirectoryName(normalizePath logicalPath)
                                        if String.IsNullOrWhiteSpace directory then None else Some(normalizePath directory))
                                    |> Seq.distinct
                                    |> Seq.sort
                                    |> Seq.map JsonValue.String
                                    |> Seq.toArray
                                    |> JsonValue.Array
                                let workspaceCount = domainDefinitions |> List.filter (fun (_, _, _, origin) -> origin = "workspace") |> List.length
                                let vanillaCount = domainDefinitions |> List.filter (fun (_, _, _, origin) -> origin = "vanilla") |> List.length
                                setCommandParameters insertDomainCommand
                                    [ "$id", box domain; "$count", box domainDefinitions.Length; "$workspace", box workspaceCount
                                      "$vanilla", box vanillaCount; "$types", box (entityTypes.ToString(JsonSaveOptions.DisableFormatting))
                                      "$directories", box (directories.ToString(JsonSaveOptions.DisableFormatting)) ]
                                insertDomainCommand.ExecuteNonQuery() |> ignore
                                let addArchetypes role origin limit =
                                    domainDefinitions
                                    |> Seq.filter (fun (_, _, _, itemOrigin) -> itemOrigin = origin)
                                    |> Seq.groupBy (fun (_, entityType, _, _) -> entityType)
                                    |> Seq.collect (fun (_, group) -> group |> Seq.truncate 2)
                                    |> Seq.truncate limit
                                    |> Seq.iteri (fun rank (definitionId, _, _, _) ->
                                        setCommandParameters insertArchetypeCommand
                                            [ "$definition", box definitionId; "$domain", box domain; "$origin", box origin
                                              "$rank", box rank; "$role", box role ]
                                        insertArchetypeCommand.ExecuteNonQuery() |> ignore)
                                addArchetypes "project_pattern" "workspace" 12
                                addArchetypes "vanilla_archetype" "vanilla" options.archetypesPerDomain

                        let generatedAt = DateTimeOffset.UtcNow
                        let oldTopologyTruncated =
                            match metadata.TryGetValue "topology_truncated" with
                            | true, value -> value.Equals("true", StringComparison.OrdinalIgnoreCase)
                            | _ -> false
                        let warnings = ResizeArray<string>()
                        if runtime.status <> "ready" then warnings.Add("The knowledge snapshot was exported while CWTools was loading or stale.")
                        if oldTopologyTruncated || freshTopology.truncated then
                            warnings.Add("Topology and event relationships are partial because the configured export limits were reached.")
                        let upsertMetadata key value =
                            use command = connection.CreateCommand()
                            command.Transaction <- transaction
                            command.CommandText <- "INSERT INTO metadata(key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
                            addParameter command "$key" (box key)
                            addParameter command "$value" (box value)
                            command.ExecuteNonQuery() |> ignore
                        upsertMetadata "status" runtime.status
                        upsertMetadata "game" activeGame
                        upsertMetadata "generated_at" (generatedAt.ToString("O"))
                        upsertMetadata "generated_at_unix_ms" (generatedAt.ToUnixTimeMilliseconds().ToString())
                        upsertMetadata "graph_version" (runtime.graphVersion.ToString())
                        upsertMetadata "generation_mode" "incremental"
                        upsertMetadata "validation_in_progress" ((string runtime.validationInProgress).ToLowerInvariant())
                        upsertMetadata "loading_in_progress" ((string runtime.loadingInProgress).ToLowerInvariant())
                        upsertMetadata "pending_global_kinds" (JsonValue.Array(runtime.pendingGlobalKinds |> List.map JsonValue.String |> List.toArray).ToString(JsonSaveOptions.DisableFormatting))
                        upsertMetadata "last_global_refresh_at_unix_ms" (runtime.lastGlobalRefreshAtUnixMs.ToString())
                        upsertMetadata "topology_truncated" ((string (oldTopologyTruncated || freshTopology.truncated)).ToLowerInvariant())
                        upsertMetadata "warnings" (JsonValue.Array(warnings |> Seq.map JsonValue.String |> Seq.toArray).ToString(JsonSaveOptions.DisableFormatting))
                        transaction.Commit()

                        let scalarCount sql =
                            use command = connection.CreateCommand()
                            command.CommandText <- sql
                            Convert.ToInt32(command.ExecuteScalar())
                        let compactDomains =
                            use command = connection.CreateCommand()
                            command.CommandText <- "SELECT id, definition_count, workspace_count, vanilla_count, entity_types_json FROM domains ORDER BY id"
                            use reader = command.ExecuteReader()
                            let values = ResizeArray<JsonValue>()
                            while reader.Read() do
                                values.Add(
                                    jsonRecord
                                        [ Some("id", JsonValue.String(reader.GetString 0))
                                          Some("definitionCount", JsonValue.Number(decimal (reader.GetInt64 1)))
                                          Some("workspaceCount", JsonValue.Number(decimal (reader.GetInt64 2)))
                                          Some("vanillaCount", JsonValue.Number(decimal (reader.GetInt64 3)))
                                          Some("entityTypes", JsonValue.Parse(reader.GetString 4)) ])
                            values.ToArray()
                        Some(
                            jsonRecord
                                [ Some("ok", JsonValue.Boolean true)
                                  Some("status", JsonValue.String runtime.status)
                                  Some("source", JsonValue.String "cwtools-project-knowledge-sqlite")
                                  Some("schemaVersion", JsonValue.Number 3m)
                                  Some("game", JsonValue.String activeGame)
                                  Some("generatedAtUnixMs", JsonValue.Number(decimal (generatedAt.ToUnixTimeMilliseconds())))
                                  Some("graphVersion", JsonValue.Number(decimal runtime.graphVersion))
                                  Some("completeExport", JsonValue.Boolean options.completeExport)
                                  Some("projectRoots", jsonStringArray projectRoots)
                                  Some("databasePath", JsonValue.String(normalizePath target))
                                  Some("generationMode", JsonValue.String "incremental")
                                  Some("domains", JsonValue.Array compactDomains)
                                  Some("counts", jsonRecord
                                    [ Some("definitions", JsonValue.Number(decimal (scalarCount "SELECT count(*) FROM definitions")))
                                      Some("availableDefinitions", JsonValue.Number(decimal (scalarCount "SELECT count(*) FROM definitions")))
                                      Some("workspaceDefinitions", JsonValue.Number(decimal (scalarCount "SELECT count(*) FROM definitions WHERE origin = 'workspace'")))
                                      Some("vanillaDefinitions", JsonValue.Number(decimal (scalarCount "SELECT count(*) FROM definitions WHERE origin = 'vanilla'")))
                                      Some("definitionStacks", JsonValue.Number(decimal (scalarCount "SELECT count(*) FROM definition_stacks")))
                                      Some("topologyFiles", JsonValue.Number(decimal (scalarCount "SELECT count(*) FROM files")))
                                      Some("topologyEdges", JsonValue.Number(decimal (scalarCount "SELECT count(*) FROM references_graph")))
                                      Some("eventNodes", JsonValue.Number(decimal (scalarCount "SELECT count(*) FROM event_nodes")))
                                      Some("eventEdges", JsonValue.Number(decimal (scalarCount "SELECT count(*) FROM event_edges")))
                                      Some("eventLogic", JsonValue.Number(decimal (scalarCount "SELECT count(*) FROM event_logic"))) ])
                                  Some("freshness", jsonRecord
                                    [ Some("validationInProgress", JsonValue.Boolean runtime.validationInProgress)
                                      Some("loadingInProgress", JsonValue.Boolean runtime.loadingInProgress)
                                      Some("pendingGlobalKinds", jsonStringArray runtime.pendingGlobalKinds)
                                      Some("lastGlobalRefreshAtUnixMs", JsonValue.Number(decimal runtime.lastGlobalRefreshAtUnixMs)) ])
                                  Some("warnings", jsonStringArray warnings) ])

let exportProjectKnowledge (activeGame: string) (projectRoots: string list) (rawOptions: ExportOptions) (runtime: RuntimeMetadata) (game: IGame<'T>) =
    let run () =
        match tryIncrementalProjectKnowledgeExport activeGame projectRoots rawOptions runtime game with
        | Some result -> result
        | None -> exportProjectKnowledgeRebuild activeGame projectRoots rawOptions runtime game
    match rawOptions.databasePath with
    | Some databasePath ->
        let key = Path.GetFullPath databasePath
        let gate = databaseWriteGates.GetOrAdd(key, fun _ -> obj())
        lock gate run
    | None -> run ()
