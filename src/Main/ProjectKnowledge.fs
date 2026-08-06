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

[<Literal>]
let KnowledgeSchemaVersion = 7

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
      overrideStrategy: string option
      provenanceKind: string
      sourceFile: string
      sourceLine: int
      sourceEndLine: int
      templateFile: string option
      templateLine: int option
      invocationFile: string option
      invocationLine: int option
      hasRealRange: bool
      confidence: string }

type private ProvenanceFact =
    { provenanceKind: string
      sourceFile: string
      sourceLine: int
      sourceEndLine: int
      templateFile: string option
      templateLine: int option
      invocationFile: string option
      invocationLine: int option
      hasRealRange: bool
      confidence: string }

let private declaredProvenance line endLine =
    let hasRealRange = line > 0 || endLine > line
    { provenanceKind = if hasRealRange then "declared" else "synthetic"
      sourceFile = ""
      sourceLine = 0
      sourceEndLine = 0
      templateFile = None
      templateLine = None
      invocationFile = None
      invocationLine = None
      hasRealRange = hasRealRange
      confidence = if hasRealRange then "high" else "medium" }

let private syntheticProvenance confidence =
    { provenanceKind = "synthetic"
      sourceFile = ""
      sourceLine = 0
      sourceEndLine = 0
      templateFile = None
      templateLine = None
      invocationFile = None
      invocationLine = None
      hasRealRange = false
      confidence = confidence }

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
      confidence: string
      callOperator: string option
      phase: string option
      delay: string option
      conditionPath: string option
      scopeMap: string option
      sourceScope: string option
      targetScope: string option }

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
      logic: EventLogicFact list
      stateAccesses: EventLogicFact list }

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

let private originName =
    function
    | PdxShaderProject.Vanilla -> "vanilla"
    | PdxShaderProject.Dependency _ -> "dependency"
    | PdxShaderProject.CurrentDocument
    | PdxShaderProject.Workspace -> "workspace"

/// Resolve provenance from the same explicit load-order roots used by the
/// shader/project runtime.  Resource scope is authoritative for vanilla and
/// embedded resources; paths outside the editable root are dependencies unless
/// CWTools explicitly marks them as vanilla.
let resolveKnowledgeOrigin projectRoots scope filePath =
    match PdxShaderProject.originForResource scope filePath with
    | PdxShaderProject.Workspace when not (projectRoots |> List.exists (fun root -> pathInside root filePath)) ->
        if String.Equals(scope, "vanilla", StringComparison.OrdinalIgnoreCase) then "vanilla" else "dependency"
    | origin -> originName origin

let private originForResource projectRoots (resource: ResourceFact option) filePath =
    let scope = resource |> Option.map _.scope |> Option.defaultValue ""
    resolveKnowledgeOrigin projectRoots scope filePath

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

let private capabilityVersionsJson =
    jsonRecord
        [ Some("inlineGraph", JsonValue.Number 2m)
          Some("stateFlow", JsonValue.Number 2m)
          Some("overrideResolution", JsonValue.Number 2m)
          Some("interfaceGraph", JsonValue.Number 1m)
          Some("localisationAudit", JsonValue.Number 2m)
          Some("pdxFlow", JsonValue.Number 2m) ]

let private capabilityStatusJson =
    jsonRecord
        [ Some("inlineGraph", JsonValue.String "ready")
          Some("stateFlow", JsonValue.String "ready")
          Some("overrideResolution", JsonValue.String "ready")
          // These are live LSP/Extension capabilities, not facts stored in this
          // SQLite snapshot. Advertising them as ready here made a missing or
          // stale live subsystem indistinguishable from exported evidence.
          Some("interfaceGraph", JsonValue.String "unavailable")
          Some("localisationAudit", JsonValue.String "unavailable")
          Some("pdxFlow", JsonValue.String "unavailable") ]

let private resourceForFile (resources: IDictionary<string, ResourceFact>) file =
    match resources.TryGetValue(normalizePath file) with
    | true, value -> Some value
    | false, _ -> None

let private configuredLoadOrderForFile (origin: string) (file: string) =
    if origin.Equals("vanilla", StringComparison.OrdinalIgnoreCase) then 0, Some "vanilla"
    else
        let candidate = PdxShaderProject.canonicalizePath file
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

let resolveKnowledgeLoadOrder origin file = configuredLoadOrderForFile origin file

let private definitionJson (definition: DefinitionFact) =
    let loadOrderIndex, loadOrderRoot = configuredLoadOrderForFile definition.origin definition.file
    jsonRecord
        [ Some("id", JsonValue.String definition.id)
          Some("entityType", JsonValue.String definition.entityType)
          Some("file", JsonValue.String(normalizePath definition.file))
          Some("logicalPath", JsonValue.String(normalizePath definition.logicalPath))
          Some("line", JsonValue.Number(decimal definition.line))
          Some("endLine", JsonValue.Number(decimal definition.endLine))
          Some("origin", JsonValue.String definition.origin)
          Some("loadOrderIndex", JsonValue.Number(decimal loadOrderIndex))
          loadOrderRoot |> Option.map (fun value -> "loadOrderRoot", JsonValue.String value)
          Some("validate", JsonValue.Boolean definition.validate)
          Some("subtypes", jsonStringArray definition.subtypes)
          Some("overwrite", JsonValue.String definition.overwrite)
          definition.resourceScope |> Option.map (fun value -> "resourceScope", JsonValue.String value)
          Some("domain", JsonValue.String definition.domain)
          definition.overridePath |> Option.map (fun value -> "overridePath", JsonValue.String value)
          definition.overrideStrategy |> Option.map (fun value -> "overrideStrategy", JsonValue.String value)
          Some("provenance", jsonRecord
            [ Some("kind", JsonValue.String definition.provenanceKind)
              Some("sourceFile", JsonValue.String(normalizePath definition.sourceFile))
              Some("sourceLine", JsonValue.Number(decimal definition.sourceLine))
              Some("sourceEndLine", JsonValue.Number(decimal definition.sourceEndLine))
              Some("hasRealRange", JsonValue.Boolean definition.hasRealRange)
              Some("confidence", JsonValue.String definition.confidence)
              definition.templateFile |> Option.map (fun value -> "templateFile", JsonValue.String(normalizePath value))
              definition.templateLine |> Option.map (fun value -> "templateLine", JsonValue.Number(decimal value))
              definition.invocationFile |> Option.map (fun value -> "invocationFile", JsonValue.String(normalizePath value))
              definition.invocationLine |> Option.map (fun value -> "invocationLine", JsonValue.Number(decimal value)) ]) ]

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

let private shaderOriginName = originName

let private collectShaderDefinitions (model: PdxShaderRuntime.ShaderRuntimeModel option) (resources: IDictionary<string, ResourceFact>) =
    match model with
    | None -> []
    | Some model ->
        let declarations =
            model.declarations
            |> List.map (fun declaration ->
                let resource = resourceForFile resources declaration.file
                let entityType, subtypes = shaderEntityType declaration.kind
                let provenance = declaredProvenance (int declaration.range.StartLine) (int declaration.range.EndLine)

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
                  overrideStrategy = None
                  provenanceKind = provenance.provenanceKind
                  sourceFile = declaration.file
                  sourceLine = int declaration.range.StartLine
                  sourceEndLine = int declaration.range.EndLine
                  templateFile = provenance.templateFile
                  templateLine = provenance.templateLine
                  invocationFile = provenance.invocationFile
                  invocationLine = provenance.invocationLine
                  hasRealRange = provenance.hasRealRange
                  confidence = provenance.confidence })

        let interfaceSprites =
            model.interfaceSprites
            |> List.choose (fun invocation ->
                invocation.spriteName
                |> Option.map (fun spriteName ->
                    let resource = resourceForFile resources invocation.sourceFile
                    let provenance = syntheticProvenance "medium"

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
                      overrideStrategy = None
                      provenanceKind = "derived"
                      sourceFile = invocation.sourceFile
                      sourceLine = int invocation.blockRange.StartLine
                      sourceEndLine = int invocation.blockRange.EndLine
                      templateFile = provenance.templateFile
                      templateLine = provenance.templateLine
                      invocationFile = provenance.invocationFile
                      invocationLine = provenance.invocationLine
                      hasRealRange = provenance.hasRealRange
                      confidence = provenance.confidence }))

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
                  overrideStrategy = None
                  provenanceKind = "synthetic"
                  sourceFile = rendererContractSource
                  sourceLine = 1
                  sourceEndLine = 1
                  templateFile = None
                  templateLine = None
                  invocationFile = None
                  invocationLine = None
                  hasRealRange = false
                  confidence = "high" })

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
                    overrideStrategy = None
                    provenanceKind = "synthetic"
                    sourceFile = source |> Option.defaultValue "shader/abi-audit.json"
                    sourceLine = 1
                    sourceEndLine = 1
                    templateFile = None
                    templateLine = None
                    invocationFile = None
                    invocationLine = None
                    hasRealRange = false
                    confidence = "high" } ]
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
                let line = int definition.range.StartLine
                let endLine = int definition.range.EndLine
                let provenance = declaredProvenance line endLine
                { id = definition.id
                  entityType = entityType
                  file = definition.range.FileName
                  logicalPath = logicalPath
                  line = line
                  endLine = endLine
                  origin = originForResource projectRoots resource definition.range.FileName
                  validate = definition.validate
                  subtypes = definition.subtypes
                  overwrite = resource |> Option.map (fun item -> item.overwrite) |> Option.defaultValue "none"
                  resourceScope = resource |> Option.map (fun item -> item.scope) |> Option.filter (String.IsNullOrWhiteSpace >> not)
                  domain = domain
                  overridePath = matchedMode |> Option.map (fun item -> item.path)
                  overrideStrategy = matchedMode |> Option.map (fun item -> item.strategy)
                  provenanceKind = provenance.provenanceKind
                  sourceFile = definition.range.FileName
                  sourceLine = line
                  sourceEndLine = int definition.range.EndLine
                  templateFile = provenance.templateFile
                  templateLine = provenance.templateLine
                  invocationFile = provenance.invocationFile
                  invocationLine = provenance.invocationLine
                  hasRealRange = provenance.hasRealRange
                  confidence = provenance.confidence }))

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

/// Deterministic baseline report for the knowledge export: provenance counts,
/// line-0 / synthetic pollution, edge label and resolution ratios, and the
/// database size. Every number is stable for identical inputs.
let private baselineJson (databasePath: string) (definitions: DefinitionFact list) (topology: TopologyFacts) (eventGraph: EventGraphFacts) (generatedAt: DateTimeOffset) (startedAt: DateTimeOffset) =
    let originCounts =
        definitions
        |> Seq.groupBy (fun item -> item.origin)
        |> Seq.map (fun (origin, values) -> origin, Seq.length values)
        |> Seq.sortBy fst
        |> Seq.toList
    let provenanceKinds =
        definitions
        |> Seq.groupBy (fun item -> item.provenanceKind)
        |> Seq.map (fun (kind, values) -> kind, Seq.length values)
        |> Seq.sortBy fst
        |> Seq.toList
    let lineZeroCount = definitions |> List.filter (fun item -> item.line <= 0) |> List.length
    let entityTypeCounts =
        definitions
        |> Seq.groupBy (fun item -> item.entityType)
        |> Seq.map (fun (entityType, values) -> entityType, Seq.length values)
        |> Seq.sortBy (fun (entityType, _) -> entityType.ToLowerInvariant())
        |> Seq.truncate 200
        |> Seq.toList
    let edgeKindCounts =
        topology.edges
        |> Seq.groupBy (fun item -> item.typeGroup)
        |> Seq.map (fun (typeGroup, values) -> typeGroup, Seq.length values)
        |> Seq.sortBy fst
        |> Seq.toList
    let edgeLabelRatio =
        if topology.edges.IsEmpty then 0.0
        else
            let labeled = topology.edges |> List.filter (fun item -> item.label |> Option.exists (String.IsNullOrWhiteSpace >> not)) |> List.length
            float labeled / float topology.edges.Length
    let eventEdgeLabelRatio =
        if eventGraph.edges.IsEmpty then 0.0
        else
            let labeled = eventGraph.edges |> List.filter (fun item -> item.label |> Option.exists (String.IsNullOrWhiteSpace >> not)) |> List.length
            float labeled / float eventGraph.edges.Length
    let eventResolutionRatio =
        if eventGraph.edges.IsEmpty then 0.0
        else
            let resolved = eventGraph.edges |> List.filter (fun item -> item.confidence <> "unresolved") |> List.length
            float resolved / float eventGraph.edges.Length
    let databaseSizeBytes =
        try
            if File.Exists databasePath then FileInfo(databasePath).Length else 0L
        with _ -> 0L
    let exportDurationMs = int ((generatedAt - startedAt).TotalMilliseconds)
    let stats (counts: (string * int) list) =
        counts
        |> List.map (fun (key, count) -> key, JsonValue.Number(decimal count))
        |> List.map (fun (key, value) -> Some(key, value))
        |> List.choose id
        |> List.toArray
        |> JsonValue.Record
    jsonRecord
        [ Some("deterministicOrdering", JsonValue.Boolean true)
          Some("exportDurationMs", JsonValue.Number(decimal exportDurationMs))
          Some("databaseSizeBytes", JsonValue.Number(decimal databaseSizeBytes))
          Some("definitions", jsonRecord
              [ Some("total", JsonValue.Number(decimal definitions.Length))
                Some("byOrigin", stats originCounts)
                Some("byProvenanceKind", stats provenanceKinds)
                Some("lineZeroRecords", JsonValue.Number(decimal lineZeroCount))
                Some("byEntityType", stats entityTypeCounts) ])
          Some("edges", jsonRecord
              [ Some("total", JsonValue.Number(decimal topology.edges.Length))
                Some("byKind", stats edgeKindCounts)
                Some("labeledRatio", JsonValue.Float edgeLabelRatio) ])
          Some("eventGraph", jsonRecord
              [ Some("nodes", JsonValue.Number(decimal eventGraph.nodes.Length))
                Some("edges", JsonValue.Number(decimal eventGraph.edges.Length))
                Some("logicFacts", JsonValue.Number(decimal eventGraph.logic.Length))
                Some("edgeLabeledRatio", JsonValue.Float eventEdgeLabelRatio)
                Some("edgeResolutionRatio", JsonValue.Float eventResolutionRatio) ]) ]

/// Unified coverage contract for every semantic query result: what was
/// considered, what was indexed, truncation and staleness. Empty results must
/// never be interpreted as "does not exist".
let private coverageJson (options: ExportOptions) (runtime: RuntimeMetadata) (definitions: DefinitionFact list) (topology: TopologyFacts) (truncated: bool) =
    jsonRecord
        [ Some("filesConsidered", JsonValue.Number(decimal topology.files.Length))
          Some("filesIndexed", JsonValue.Number(decimal topology.files.Length))
          Some("definitionsConsidered", JsonValue.Number(decimal definitions.Length))
          Some("definitionsIndexed", JsonValue.Number(decimal definitions.Length))
          Some("edgesConsidered", JsonValue.Number(decimal topology.edges.Length))
          Some("edgesIndexed", JsonValue.Number(decimal topology.edges.Length))
          Some("truncated", JsonValue.Boolean truncated)
          Some("staleReasons", jsonStringArray
              [ if runtime.status <> "ready" then yield "lsp_not_ready"
                if truncated then yield "export_limits_reached"
                if definitions |> List.forall (fun item -> item.origin <> "vanilla") then yield "no_vanilla_definitions" ])
          Some("unsupportedConstructs", jsonStringArray
              [ if options.generationMode = "incremental" && not (options.domains.IsEmpty || options.changedFiles.IsEmpty) then yield "partial_export_scope" ]) ]

type private DefinitionStackResolution =
    { ordered: DefinitionFact list
      winner: DefinitionFact option
      resolution: string
      ambiguousReason: string option }

let private resolveDefinitionStack (items: DefinitionFact list) =
    let ordered =
        items
        |> List.sortBy (fun item ->
            let loadOrderIndex, _ = configuredLoadOrderForFile item.origin item.file
            loadOrderIndex, normalizePath item.logicalPath, normalizePath item.file, item.line)
    let overwriteActive = ordered |> List.filter (fun item -> item.overwrite <> "overwritten")
    let strategies =
        ordered
        |> List.choose (fun item -> item.overrideStrategy)
        |> List.map (fun value -> value.ToUpperInvariant())
        |> List.distinct
    let strategy = strategies |> List.tryHead
    if overwriteActive.Length = 1 then
        { ordered = ordered; winner = overwriteActive |> List.tryHead; resolution = "cwtools_single_active"; ambiguousReason = None }
    else
        match strategy with
        | Some "LIOS" ->
            { ordered = ordered; winner = ordered |> List.tryLast; resolution = "last_in_only_served"; ambiguousReason = None }
        | Some "FIOS" ->
            { ordered = ordered; winner = ordered |> List.tryHead; resolution = "first_in_only_served"; ambiguousReason = None }
        | Some "NO" ->
            { ordered = ordered
              winner = ordered |> List.tryHead
              resolution = "no_individual_override"
              ambiguousReason = Some "NO does not permit an individual same-key override; the earliest existing candidate remains effective unless the owning file is replaced." }
        | Some "MERGE" ->
            { ordered = ordered; winner = None; resolution = "merged_definitions"; ambiguousReason = Some "MERGE keeps contributions from multiple candidates; there is no single winner." }
        | Some "DUPL" ->
            { ordered = ordered; winner = None; resolution = "duplicate_definitions"; ambiguousReason = Some "DUPL permits multiple candidates; there is no single winner." }
        | Some mode ->
            { ordered = ordered; winner = None; resolution = "ambiguous"; ambiguousReason = Some(sprintf "Override mode %s has no deterministic resolver." mode) }
        | None ->
            { ordered = ordered; winner = None; resolution = "ambiguous"; ambiguousReason = Some "No active override mode or unique CWTools overwrite winner was available." }

let private definitionStacks (definitions: DefinitionFact seq) =
    definitions
    |> Seq.groupBy (fun definition -> definition.entityType.ToLowerInvariant(), definition.id.ToLowerInvariant())
    |> Seq.choose (fun ((_entityTypeKey, _idKey), values) ->
        let items = values |> Seq.toList
        if items.Length <= 1 then None
        else
            let resolved = resolveDefinitionStack items
            let entityType = resolved.ordered.Head.entityType
            let id = resolved.ordered.Head.id
            let origins = items |> List.map (fun item -> item.origin) |> List.distinct
            Some(
                jsonRecord
                    [ Some("entityType", JsonValue.String entityType)
                      Some("id", JsonValue.String id)
                      Some("origins", jsonStringArray origins)
                      Some("resolution", JsonValue.String resolved.resolution)
                      Some("ambiguous", JsonValue.Boolean(resolved.resolution = "ambiguous"))
                      resolved.ambiguousReason |> Option.map (fun reason -> "ambiguousReason", JsonValue.String reason)
                      resolved.winner |> Option.map (fun winner -> "winner", definitionJson winner)
                      Some("definitions", JsonValue.Array(resolved.ordered |> List.map definitionJson |> List.toArray))
                      Some("losers", JsonValue.Array(
                          (match resolved.winner with
                           | Some winner -> resolved.ordered |> List.filter ((<>) winner)
                           | None -> [])
                          |> List.map definitionJson |> List.toArray)) ]))
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

    let resources = resourceFacts (game :> IGame)

    for struct (entity, lazyData) in game.AllEntities() do
        let resource = resourceForFile resources entity.filepath
        if originForResource projectRoots resource entity.filepath = "workspace" then
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
                          origin = originForResource projectRoots resource entity.filepath })

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
                      confidence = "lsp"
                      callOperator = reference.associatedType
                      phase = None
                      delay = None
                      conditionPath = None
                      scopeMap = None
                      sourceScope = reference.associatedType
                      targetScope = None }
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
                          confidence = "lsp"
                          callOperator = reference.associatedType
                          phase = None
                          delay = None
                          conditionPath = None
                          scopeMap = None
                          sourceScope = reference.associatedType
                          targetScope = None })

    // ─── State access extraction ────────────────────────────────────────────
    // Variables, flags and event targets touched inside an event definition,
    // with the phase (trigger/immediate/option/...) and condition path they
    // sit under. Written as EventLogicFact rows so they share the same query
    // surface; relation_type names the operation family.
    let stateAccesses = ResizeArray<EventLogicFact>()
    let variableOperators =
        dict [
            "set_variable", "variable_set"
            "change_variable", "variable_change"
            "clear_variable", "variable_clear"
            "check_variable", "variable_check"
            "export_to_variable", "variable_export"
            "read_global_variable", "variable_read"
        ]
    let flagOperators =
        [ "set_country_flag", "country_flag_set"; "remove_country_flag", "country_flag_remove"
          "has_country_flag", "country_flag_check"
          "set_planet_flag", "planet_flag_set"; "remove_planet_flag", "planet_flag_remove"
          "has_planet_flag", "planet_flag_check"
          "set_fleet_flag", "fleet_flag_set"; "remove_fleet_flag", "fleet_flag_remove"
          "has_fleet_flag", "fleet_flag_check"
          "set_ship_flag", "ship_flag_set"; "remove_ship_flag", "ship_flag_remove"
          "has_ship_flag", "ship_flag_check"
          "set_system_flag", "system_flag_set"; "remove_system_flag", "system_flag_remove"
          "has_system_flag", "system_flag_check"
          "set_global_flag", "global_flag_set"; "remove_global_flag", "global_flag_remove"
          "has_global_flag", "global_flag_check" ]
        |> dict
    let targetOperators =
        dict [
            "save_event_target_as", "event_target_save"
            "save_global_event_target_as", "global_event_target_save"
            "clear_event_target", "event_target_clear"
            "clear_global_event_target", "global_event_target_clear"
        ]
    let lifecycleOperators =
        [ "has_technology", "technology_check"; "give_technology", "technology_unlock"; "set_technology", "technology_set"
          "enable_special_project", "special_project_enable"; "abort_special_project", "special_project_abort"; "complete_special_project", "special_project_complete"
          "start_situation", "situation_start"; "abort_situation", "situation_abort"; "complete_situation", "situation_complete"
          "add_situation_progress", "situation_progress_change"; "set_situation_progress", "situation_progress_set"
          "begin_event_chain", "event_chain_begin"; "end_event_chain", "event_chain_end" ]
        |> dict
    let createdObjectOperators =
        [ "create_country", "last_created_country"; "create_fleet", "last_created_fleet"; "create_ship", "last_created_ship"
          "create_pop", "last_created_pop"; "create_species", "last_created_species"; "create_leader", "last_created_leader"
          "create_army", "last_created_army"; "create_planet", "last_created_planet"; "create_starbase", "last_created_starbase"
          "create_megastructure", "last_created_megastructure" ]
        |> dict
    let eventCallOperators =
        [ "country_event"; "fleet_event"; "ship_event"; "planet_event"; "system_event"
          "starbase_event"; "megastructure_event"; "pop_event"; "army_event"; "ambient_object_event"
          "fire_on_action" ]
        |> Set.ofList
    let phaseOf (node: Node) =
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
    let conditionPathOf (path: string list) =
        if path.IsEmpty then None
        else
            let ordered = path |> List.rev
            let role =
                if ordered |> List.exists (fun item -> item = "not" || item = "nor" || item = "else") then "blocks"
                elif ordered |> List.exists (fun item -> item = "or" || item = "random_list" || item = "switch" || item = "else_if") then "alternative"
                else "requires"
            Some(role + ":" + String.concat ">" ordered)

    let subjectFromNode (node: Node) =
        node.Leaves
        |> Seq.tryFind (fun leaf ->
            leaf.Key.Equals("which", StringComparison.OrdinalIgnoreCase)
            || leaf.Key.Equals("name", StringComparison.OrdinalIgnoreCase)
            || leaf.Key.Equals("flag", StringComparison.OrdinalIgnoreCase)
            || leaf.Key.Equals("target", StringComparison.OrdinalIgnoreCase)
            || leaf.Key.Equals("technology", StringComparison.OrdinalIgnoreCase)
            || leaf.Key.Equals("tech", StringComparison.OrdinalIgnoreCase)
            || leaf.Key.Equals("project", StringComparison.OrdinalIgnoreCase)
            || leaf.Key.Equals("situation", StringComparison.OrdinalIgnoreCase)
            || leaf.Key.Equals("type", StringComparison.OrdinalIgnoreCase))
        |> Option.orElseWith (fun () -> node.Leaves |> Seq.tryHead)
        |> Option.map (fun leaf -> string leaf.Value |> fun value -> value.Trim().Trim('"'))
        |> Option.orElseWith (fun () -> node.Values |> Seq.tryHead |> Option.map (fun leaf -> string leaf.Value |> fun value -> value.Trim().Trim('"')))

    let scopeForCallOperator (operator: string) =
        if operator.EndsWith("_event", StringComparison.OrdinalIgnoreCase) then
            Some(operator.Substring(0, operator.Length - "_event".Length))
        else None

    let addStateAccess eventId (relationType: string) subject phase file line details =
        if not (String.IsNullOrWhiteSpace subject) then
            let stateScope =
                if relationType.StartsWith("global_event_target", StringComparison.OrdinalIgnoreCase) then Some "global"
                elif relationType.StartsWith("event_target", StringComparison.OrdinalIgnoreCase) then Some "local_event"
                elif relationType.StartsWith("country_", StringComparison.OrdinalIgnoreCase) then Some "country"
                elif relationType.StartsWith("planet_", StringComparison.OrdinalIgnoreCase) then Some "planet"
                elif relationType.StartsWith("fleet_", StringComparison.OrdinalIgnoreCase) then Some "fleet"
                elif relationType.StartsWith("ship_", StringComparison.OrdinalIgnoreCase) then Some "ship"
                elif relationType.StartsWith("system_", StringComparison.OrdinalIgnoreCase) then Some "system"
                elif relationType.StartsWith("global_", StringComparison.OrdinalIgnoreCase) then Some "global"
                elif relationType.StartsWith("variable_", StringComparison.OrdinalIgnoreCase) then Some "current_scope"
                elif relationType.StartsWith("technology_", StringComparison.OrdinalIgnoreCase) then Some "country"
                elif relationType.StartsWith("special_project_", StringComparison.OrdinalIgnoreCase) then Some "country"
                elif relationType.StartsWith("situation_", StringComparison.OrdinalIgnoreCase) then Some "situation"
                elif relationType.StartsWith("event_chain_", StringComparison.OrdinalIgnoreCase) then Some "country"
                elif relationType = "created_object_produce" then Some "implicit_last_created"
                elif relationType = "created_object_read" then Some "implicit_last_created"
                else None
            stateAccesses.Add
                { eventId = eventId
                  relationType = relationType
                  subject = subject
                  scope = stateScope
                  phase = if String.IsNullOrWhiteSpace phase then "effect" else phase
                  sourceFile = file
                  line = line
                  details = details }

    let rec walkEffects (eventId: string) (sourceScope: string option) (file: string) (phase: string) (conditionPath: string list) (node: Node) =
        // Scalar script statements live in Node.Values and are not guaranteed
        // to appear in Node.All. Handle them explicitly so common flag/target
        // operations and leaf-form event calls are not lost.
        for leaf in node.Values do
            let key = leaf.Key.ToLowerInvariant()
            let subject = string leaf.Value |> fun value -> value.Trim().Trim('"')
            if eventCallOperators.Contains key && not (String.IsNullOrWhiteSpace subject) then
                edges.Add
                    { sourceKind = "event"
                      sourceId = eventId
                      targetEventId = subject
                      edgeType = "event_call"
                      label = Some key
                      sourceFile = file
                      line = int leaf.Position.StartLine
                      confidence = if eventIds.Contains(subject.ToLowerInvariant()) then "ast_resolved" else "ast_unresolved"
                      callOperator = Some key
                      phase = Some(if String.IsNullOrWhiteSpace phase then "effect" else phase)
                      delay = None
                      conditionPath = conditionPathOf conditionPath
                      scopeMap = None
                      sourceScope = sourceScope
                      targetScope = scopeForCallOperator key }
            match variableOperators.TryGetValue key with
            | true, relationType -> addStateAccess eventId relationType subject phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
            | _ ->
                match targetOperators.TryGetValue key with
                | true, relationType -> addStateAccess eventId relationType subject phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
                | _ ->
                    match flagOperators.TryGetValue key with
                    | true, relationType -> addStateAccess eventId relationType subject phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
                    | _ -> ()
            match lifecycleOperators.TryGetValue key with
            | true, relationType -> addStateAccess eventId relationType subject phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
            | _ -> ()
            match createdObjectOperators.TryGetValue key with
            | true, createdSubject -> addStateAccess eventId "created_object_produce" createdSubject phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
            | _ -> ()
            let raw = key + "=" + subject
            for found in Regex.Matches(raw, @"event_target:([A-Za-z_][A-Za-z0-9_.-]*)", RegexOptions.IgnoreCase) do
                addStateAccess eventId "event_target_read" found.Groups.[1].Value phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
            for found in Regex.Matches(raw, @"last_created_[A-Za-z_][A-Za-z0-9_]*", RegexOptions.IgnoreCase) do
                addStateAccess eventId "created_object_read" found.Value phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
        for child in node.All do
            match child with
            | NodeC childNode ->
                let key = childNode.Key.ToLowerInvariant()
                let childPhase = if phaseOf childNode <> "" then phaseOf childNode else phase
                let isCondition =
                    key = "if" || key = "else_if" || key = "else"
                    || key = "and" || key = "or" || key = "nor" || key = "not"
                    || key = "random_list" || key = "switch" || key = "while"
                let nextPath =
                    if key = "if" || key = "else_if" || key = "else" || key = "and"
                       || key = "or" || key = "nor" || key = "not" || key = "random_list"
                       || key = "switch" || key = "while" then
                        key :: conditionPath
                    else conditionPath
                if eventCallOperators.Contains key then
                    let targetId = tryDirectLeafValue "id" childNode
                    targetId
                    |> Option.filter (String.IsNullOrWhiteSpace >> not)
                    |> Option.iter (fun target ->
                        let delay =
                            [ "days"; "months"; "years"; "random" ]
                            |> List.choose (fun delayKey -> tryDirectLeafValue delayKey childNode |> Option.map (fun value -> delayKey + "=" + value))
                            |> function [] -> None | values -> Some(String.concat "," values)
                        let scopeMap =
                            childNode.Nodes
                            |> Seq.tryFind (fun inner -> inner.Key.Equals("scopes", StringComparison.OrdinalIgnoreCase))
                            |> Option.map (fun scopes ->
                                scopes.Leaves
                                |> Seq.map (fun leaf -> leaf.Key + "->" + string leaf.Value)
                                |> Seq.sort
                                |> String.concat ",")
                            |> Option.filter (String.IsNullOrWhiteSpace >> not)
                        edges.Add
                            { sourceKind = "event"
                              sourceId = eventId
                              targetEventId = target.Trim().Trim('"')
                              edgeType = "event_call"
                              label = Some key
                              sourceFile = file
                              line = int childNode.Position.StartLine
                              confidence = if eventIds.Contains(target.Trim().Trim('"').ToLowerInvariant()) then "ast_resolved" else "ast_unresolved"
                              callOperator = Some key
                              phase = Some(if String.IsNullOrWhiteSpace childPhase then "effect" else childPhase)
                              delay = delay
                              conditionPath = conditionPathOf nextPath
                              scopeMap = scopeMap
                              sourceScope = sourceScope
                              targetScope = scopeForCallOperator key })
                match variableOperators.TryGetValue key with
                | true, relationType ->
                    subjectFromNode childNode
                    |> Option.iter (fun subject -> addStateAccess eventId relationType subject childPhase file (int childNode.Position.StartLine) (conditionPathOf nextPath))
                | _ ->
                    match targetOperators.TryGetValue key with
                    | true, relationType ->
                        subjectFromNode childNode
                        |> Option.iter (fun subject -> addStateAccess eventId relationType subject childPhase file (int childNode.Position.StartLine) (conditionPathOf nextPath))
                    | _ ->
                        match flagOperators.TryGetValue key with
                        | true, relationType ->
                            subjectFromNode childNode
                            |> Option.iter (fun subject -> addStateAccess eventId relationType subject childPhase file (int childNode.Position.StartLine) (conditionPathOf nextPath))
                        | _ -> ()
                match lifecycleOperators.TryGetValue key with
                | true, relationType ->
                    subjectFromNode childNode
                    |> Option.iter (fun subject -> addStateAccess eventId relationType subject childPhase file (int childNode.Position.StartLine) (conditionPathOf nextPath))
                | _ -> ()
                match createdObjectOperators.TryGetValue key with
                | true, createdSubject -> addStateAccess eventId "created_object_produce" createdSubject childPhase file (int childNode.Position.StartLine) (conditionPathOf nextPath)
                | _ -> ()
                // event_target:name reads
                if key.StartsWith "event_target:" then
                    let targetName = key.Substring "event_target:".Length
                    if not (String.IsNullOrWhiteSpace targetName) then
                        stateAccesses.Add
                            { eventId = eventId
                              relationType = "event_target_read"
                              subject = targetName
                              scope = Some "local_event"
                              phase = if childPhase <> "" then childPhase else "effect"
                              sourceFile = file
                              line = int childNode.Position.StartLine
                              details = conditionPathOf nextPath }
                if isCondition || childPhase <> phase || key = "effect" then
                    walkEffects eventId sourceScope file childPhase nextPath childNode
                else
                    walkEffects eventId sourceScope file phase nextPath childNode
            | LeafC leaf ->
                let key = leaf.Key.ToLowerInvariant()
                let subject = string leaf.Value |> fun value -> value.Trim().Trim('"')
                match variableOperators.TryGetValue key with
                | true, relationType -> addStateAccess eventId relationType subject phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
                | _ ->
                    match targetOperators.TryGetValue key with
                    | true, relationType -> addStateAccess eventId relationType subject phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
                    | _ ->
                        match flagOperators.TryGetValue key with
                        | true, relationType -> addStateAccess eventId relationType subject phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
                        | _ -> ()
                match lifecycleOperators.TryGetValue key with
                | true, relationType -> addStateAccess eventId relationType subject phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
                | _ -> ()
                match createdObjectOperators.TryGetValue key with
                | true, createdSubject -> addStateAccess eventId "created_object_produce" createdSubject phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
                | _ -> ()
                let raw = key + "=" + subject
                for found in Regex.Matches(raw, @"event_target:([A-Za-z_][A-Za-z0-9_.-]*)", RegexOptions.IgnoreCase) do
                    let targetName = found.Groups.[1].Value
                    addStateAccess eventId "event_target_read" targetName phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
                for found in Regex.Matches(raw, @"last_created_[A-Za-z_][A-Za-z0-9_]*", RegexOptions.IgnoreCase) do
                    addStateAccess eventId "created_object_read" found.Value phase file (int leaf.Position.StartLine) (conditionPathOf conditionPath)
            | _ -> ()

    // Locate each event definition's AST node once.
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

    for definition in eventDefinitions do
        match rootsByFile.TryGetValue(normalizePath definition.file) with
        | false, _ -> ()
        | true, roots ->
            roots
            |> Seq.collect descendantNodes
            |> Seq.filter (fun node ->
                int node.Position.StartLine <= definition.line
                && int node.Position.EndLine >= definition.endLine)
            |> Seq.sortBy (fun node -> int node.Position.EndLine - int node.Position.StartLine)
            |> Seq.tryHead
            |> Option.iter (fun node ->
                let eventScope =
                    definition.subtypes
                    |> List.tryHead
                    |> Option.bind (fun subtype ->
                        scopeForCallOperator subtype
                        |> Option.orElseWith (fun () -> if String.IsNullOrWhiteSpace subtype then None else Some subtype))
                walkEffects definition.id eventScope (normalizePath definition.file) "" [] node)

    let distinctEdges =
        edges
        |> Seq.groupBy (fun item -> item.sourceKind, item.sourceId, item.targetEventId, item.line)
        |> Seq.map (fun (_, candidates) ->
            candidates
            |> Seq.sortByDescending (fun item ->
                [ item.callOperator; item.phase; item.delay; item.conditionPath; item.scopeMap; item.sourceScope; item.targetScope ]
                |> List.sumBy (function Some value when not (String.IsNullOrWhiteSpace value) -> 1 | _ -> 0))
            |> Seq.head)
    let distinctLogic = logic |> Seq.distinctBy (fun item -> item.eventId, item.relationType, item.subject, item.scope, item.line)
    let distinctState = stateAccesses |> Seq.distinctBy (fun item -> item.eventId, item.relationType, item.subject, item.phase, item.line) |> Seq.truncate 30000 |> Seq.toList
    { nodes = nodes |> Seq.distinctBy (fun item -> item.eventId, item.file, item.line) |> Seq.toList
      edges = (if options.completeExport then distinctEdges else distinctEdges |> Seq.truncate 30000) |> Seq.toList
      logic = (if options.completeExport then distinctLogic else distinctLogic |> Seq.truncate 30000) |> Seq.toList
      stateAccesses = distinctState }

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
  override_strategy TEXT,
  provenance_kind TEXT NOT NULL DEFAULT 'declared',
  source_file TEXT NOT NULL DEFAULT '',
  source_line INTEGER NOT NULL DEFAULT 0,
  source_end_line INTEGER NOT NULL DEFAULT 0,
  template_file TEXT,
  template_line INTEGER,
  invocation_file TEXT,
  invocation_line INTEGER,
  has_real_range INTEGER NOT NULL DEFAULT 1,
  confidence TEXT NOT NULL DEFAULT 'high'
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
  candidate_order INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT '',
  logical_path TEXT NOT NULL DEFAULT '',
  override_strategy TEXT,
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
  confidence TEXT NOT NULL,
  call_operator TEXT,
  phase TEXT,
  delay TEXT,
  condition_path TEXT,
  scope_map TEXT,
  source_scope TEXT,
  target_scope TEXT
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
CREATE TABLE inline_templates (
  template_id TEXT PRIMARY KEY,
  logical_path TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE TABLE inline_parameters (
  template_id TEXT NOT NULL,
  name TEXT NOT NULL,
  usage_kind TEXT NOT NULL,
  usage_kinds TEXT NOT NULL,
  inferred_type TEXT NOT NULL,
  required INTEGER NOT NULL,
  occurrences INTEGER NOT NULL,
  PRIMARY KEY(template_id, name)
);
CREATE TABLE inline_invocations (
  invocation_id TEXT PRIMARY KEY,
  caller_file TEXT NOT NULL,
  caller_line INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  enclosing_definition TEXT
);
CREATE TABLE inline_arguments (
  invocation_id TEXT NOT NULL REFERENCES inline_invocations(invocation_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  resolved_value TEXT NOT NULL,
  value_kind TEXT NOT NULL,
  PRIMARY KEY(invocation_id, name)
);
CREATE TABLE inline_expansions (
  invocation_id TEXT NOT NULL REFERENCES inline_invocations(invocation_id) ON DELETE CASCADE,
  expanded_symbol_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  template_file TEXT NOT NULL,
  caller_file TEXT NOT NULL,
  template_line INTEGER NOT NULL,
  generated_line INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  PRIMARY KEY(invocation_id, expanded_symbol_id)
);
CREATE TABLE inline_generated_references (
  invocation_id TEXT NOT NULL REFERENCES inline_invocations(invocation_id) ON DELETE CASCADE,
  reference_kind TEXT NOT NULL,
  expanded_value TEXT NOT NULL,
  template_file TEXT NOT NULL,
  caller_file TEXT NOT NULL,
  template_line INTEGER NOT NULL,
  generated_line INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  PRIMARY KEY(invocation_id, reference_kind, expanded_value, template_line)
);
CREATE TABLE inline_problems (
  invocation_id TEXT NOT NULL REFERENCES inline_invocations(invocation_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  line INTEGER NOT NULL
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
CREATE INDEX idx_inline_templates_logical ON inline_templates(logical_path COLLATE NOCASE);
CREATE INDEX idx_inline_templates_file ON inline_templates(file COLLATE NOCASE, line);
CREATE INDEX idx_inline_invocations_template ON inline_invocations(template_id COLLATE NOCASE);
CREATE INDEX idx_inline_invocations_caller ON inline_invocations(caller_file COLLATE NOCASE, caller_line);
CREATE INDEX idx_inline_expansions_symbol ON inline_expansions(expanded_symbol_id COLLATE NOCASE);
CREATE INDEX idx_inline_generated_value ON inline_generated_references(reference_kind, expanded_value COLLATE NOCASE);
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

let private writeKnowledgeDatabase (databasePath: string) (activeGame: string) (projectRoots: string list) (options: ExportOptions) (runtime: RuntimeMetadata) (definitions: DefinitionFact list) (topology: TopologyFacts) (eventGraph: EventGraphFacts) (inlineGraph: InlineGraph.InlineGraphFacts) (game: IGame) (warnings: seq<string>) =
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
    insertMetadata "schema_version" (string KnowledgeSchemaVersion)
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
    insertMetadata "definition_count" (definitions.Length.ToString())
    insertMetadata "topology_file_count" (topology.files.Length.ToString())
    insertMetadata "topology_edge_count" (topology.edges.Length.ToString())

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
    definitionCommand.CommandText <- "INSERT INTO definitions(symbol_id, entity_type, file_path, logical_path, line, end_line, origin, validate, overwrite_state, resource_scope, domain, override_path, override_strategy, provenance_kind, source_file, source_line, source_end_line, template_file, template_line, invocation_file, invocation_line, has_real_range, confidence) VALUES ($symbol, $type, $file, $logical, $line, $end, $origin, $validate, $overwrite, $scope, $domain, $overridePath, $overrideStrategy, $provenance, $sourceFile, $sourceLine, $sourceEndLine, $templateFile, $templateLine, $invocationFile, $invocationLine, $hasRealRange, $confidence) RETURNING id"
    prepareCommandParameters definitionCommand
        [ "$symbol", box ""; "$type", box ""; "$file", box ""; "$logical", box ""; "$line", box 0; "$end", box 0
          "$origin", box ""; "$validate", box 0; "$overwrite", box ""; "$scope", box ""; "$domain", box ""
          "$overridePath", box ""; "$overrideStrategy", box ""; "$provenance", box ""; "$sourceFile", box ""
          "$sourceLine", box 0; "$sourceEndLine", box 0; "$templateFile", box ""; "$templateLine", box 0
          "$invocationFile", box ""; "$invocationLine", box 0; "$hasRealRange", box 0; "$confidence", box "" ]
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
              "$overridePath", box (definition.overridePath |> Option.toObj); "$overrideStrategy", box (definition.overrideStrategy |> Option.toObj)
              "$provenance", box definition.provenanceKind; "$sourceFile", box (normalizePath definition.sourceFile)
              "$sourceLine", box definition.sourceLine; "$sourceEndLine", box definition.sourceEndLine
              "$templateFile", box (definition.templateFile |> Option.toObj); "$templateLine", box (definition.templateLine |> Option.map box |> Option.toObj)
              "$invocationFile", box (definition.invocationFile |> Option.toObj); "$invocationLine", box (definition.invocationLine |> Option.map box |> Option.toObj)
              "$hasRealRange", box (if definition.hasRealRange then 1 else 0); "$confidence", box definition.confidence ]
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
    candidateCommand.CommandText <- "INSERT OR IGNORE INTO stack_candidates(stack_id, definition_id, is_active, candidate_order, origin, logical_path, override_strategy) VALUES ($stack, $definition, $active, $order, $origin, $logical, $strategy)"
    use unresolvedCommand = connection.CreateCommand()
    unresolvedCommand.Transaction <- transaction
    unresolvedCommand.CommandText <- "INSERT INTO unresolved(kind, entity_type, symbol_id, resolution, message) VALUES ($kind, $type, $symbol, $resolution, $message)"
    for ((_typeKey, _idKey), values) in definitions |> Seq.groupBy (fun item -> item.entityType.ToLowerInvariant(), item.id.ToLowerInvariant()) do
        let items = values |> Seq.toList
        if items.Length > 1 then
            let resolved = resolveDefinitionStack items
            setCommandParameters stackCommand [ "$type", box resolved.ordered.Head.entityType; "$symbol", box resolved.ordered.Head.id; "$resolution", box resolved.resolution ]
            let stackId = stackCommand.ExecuteScalar() :?> int64
            for index, definition in resolved.ordered |> List.indexed do
                match definitionIds.TryGetValue(definitionKey definition) with
                | true, definitionId ->
                    setCommandParameters candidateCommand
                        [ "$stack", box stackId; "$definition", box definitionId; "$active", box (if resolved.winner = Some definition then 1 else 0)
                          "$order", box index; "$origin", box definition.origin; "$logical", box (normalizePath definition.logicalPath)
                          "$strategy", box (definition.overrideStrategy |> Option.toObj) ]
                    candidateCommand.ExecuteNonQuery() |> ignore
                | _ -> ()
            if resolved.winner.IsNone && resolved.resolution <> "merged_definitions" && resolved.resolution <> "duplicate_definitions" then
                setCommandParameters unresolvedCommand
                    [ "$kind", box "definition_resolution"; "$type", box resolved.ordered.Head.entityType; "$symbol", box resolved.ordered.Head.id; "$resolution", box resolved.resolution
                      "$message", box (resolved.ambiguousReason |> Option.defaultValue "The effective definition remains ambiguous.") ]
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
    eventEdgeCommand.CommandText <- "INSERT INTO event_edges(source_kind, source_id, target_event_id, edge_type, label, source_file, line, confidence, call_operator, phase, delay, condition_path, scope_map, source_scope, target_scope) VALUES ($kind, $source, $target, $type, $label, $file, $line, $confidence, $callOperator, $phase, $delay, $conditionPath, $scopeMap, $sourceScope, $targetScope)"
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
    for item in eventGraph.stateAccesses do
        setPreparedCommandParameters eventLogicCommand
            [ "$event", box item.eventId; "$type", box item.relationType; "$subject", box item.subject; "$scope", box (item.scope |> Option.toObj)
              "$phase", box item.phase; "$file", box item.sourceFile; "$line", box item.line; "$details", box (item.details |> Option.toObj) ]
        eventLogicCommand.ExecuteNonQuery() |> ignore

    // Inline-script instantiation graph (current schema).
    use inlineTemplateCommand = connection.CreateCommand()
    inlineTemplateCommand.Transaction <- transaction
    inlineTemplateCommand.CommandText <- "INSERT OR REPLACE INTO inline_templates(template_id, logical_path, file, line, content_hash) VALUES ($id, $logical, $file, $line, $hash)"
    prepareCommandParameters inlineTemplateCommand
        [ "$id", box ""; "$logical", box ""; "$file", box ""; "$line", box 0; "$hash", box "" ]
    for template in inlineGraph.templates do
        setPreparedCommandParameters inlineTemplateCommand
            [ "$id", box template.templateId; "$logical", box template.logicalPath; "$file", box template.file
              "$line", box template.line; "$hash", box template.contentHash ]
        inlineTemplateCommand.ExecuteNonQuery() |> ignore
    use inlineParameterCommand = connection.CreateCommand()
    inlineParameterCommand.Transaction <- transaction
    inlineParameterCommand.CommandText <- "INSERT OR REPLACE INTO inline_parameters(template_id, name, usage_kind, usage_kinds, inferred_type, required, occurrences) VALUES ($id, $name, $kind, $kinds, $inferred, $required, $occurrences)"
    prepareCommandParameters inlineParameterCommand
        [ "$id", box ""; "$name", box ""; "$kind", box ""; "$kinds", box ""; "$inferred", box ""; "$required", box 0; "$occurrences", box 0 ]
    for parameter in inlineGraph.parameters do
        setPreparedCommandParameters inlineParameterCommand
            [ "$id", box parameter.templateId; "$name", box parameter.name; "$kind", box parameter.usageKind
              "$kinds", box (String.concat "|" parameter.usageKinds); "$inferred", box parameter.inferredType
              "$required", box (if parameter.required then 1 else 0); "$occurrences", box parameter.occurrences ]
        inlineParameterCommand.ExecuteNonQuery() |> ignore
    use inlineInvocationCommand = connection.CreateCommand()
    inlineInvocationCommand.Transaction <- transaction
    inlineInvocationCommand.CommandText <- "INSERT OR REPLACE INTO inline_invocations(invocation_id, caller_file, caller_line, template_id, enclosing_definition) VALUES ($id, $file, $line, $template, $enclosing)"
    prepareCommandParameters inlineInvocationCommand
        [ "$id", box ""; "$file", box ""; "$line", box 0; "$template", box ""; "$enclosing", box "" ]
    for invocation in inlineGraph.invocations do
        setPreparedCommandParameters inlineInvocationCommand
            [ "$id", box invocation.invocationId; "$file", box invocation.callerFile; "$line", box invocation.callerLine
              "$template", box invocation.templateId; "$enclosing", box (invocation.enclosingDefinition |> Option.toObj) ]
        inlineInvocationCommand.ExecuteNonQuery() |> ignore
    use inlineArgumentCommand = connection.CreateCommand()
    inlineArgumentCommand.Transaction <- transaction
    inlineArgumentCommand.CommandText <- "INSERT OR REPLACE INTO inline_arguments(invocation_id, name, raw_value, resolved_value, value_kind) VALUES ($id, $name, $raw, $resolved, $kind)"
    prepareCommandParameters inlineArgumentCommand
        [ "$id", box ""; "$name", box ""; "$raw", box ""; "$resolved", box ""; "$kind", box "" ]
    for argument in inlineGraph.arguments do
        setPreparedCommandParameters inlineArgumentCommand
            [ "$id", box argument.invocationId; "$name", box argument.name; "$raw", box argument.rawValue
              "$resolved", box argument.resolvedValue; "$kind", box argument.valueKind ]
        inlineArgumentCommand.ExecuteNonQuery() |> ignore
    use inlineExpansionCommand = connection.CreateCommand()
    inlineExpansionCommand.Transaction <- transaction
    inlineExpansionCommand.CommandText <- "INSERT OR REPLACE INTO inline_expansions(invocation_id, expanded_symbol_id, entity_type, template_file, caller_file, template_line, generated_line, confidence) VALUES ($id, $symbol, $type, $templateFile, $callerFile, $templateLine, $generatedLine, $confidence)"
    prepareCommandParameters inlineExpansionCommand
        [ "$id", box ""; "$symbol", box ""; "$type", box ""; "$templateFile", box ""; "$callerFile", box ""; "$templateLine", box 0; "$generatedLine", box 0; "$confidence", box "" ]
    for expansion in inlineGraph.expansions do
        setPreparedCommandParameters inlineExpansionCommand
            [ "$id", box expansion.invocationId; "$symbol", box expansion.expandedSymbolId; "$type", box expansion.entityType
              "$templateFile", box expansion.templateFile; "$callerFile", box expansion.callerFile
              "$templateLine", box expansion.templateLine; "$generatedLine", box expansion.generatedLine; "$confidence", box expansion.confidence ]
        inlineExpansionCommand.ExecuteNonQuery() |> ignore
    use inlineGeneratedReferenceCommand = connection.CreateCommand()
    inlineGeneratedReferenceCommand.Transaction <- transaction
    inlineGeneratedReferenceCommand.CommandText <- "INSERT OR REPLACE INTO inline_generated_references(invocation_id, reference_kind, expanded_value, template_file, caller_file, template_line, generated_line, confidence) VALUES ($id, $kind, $value, $templateFile, $callerFile, $templateLine, $generatedLine, $confidence)"
    prepareCommandParameters inlineGeneratedReferenceCommand
        [ "$id", box ""; "$kind", box ""; "$value", box ""; "$templateFile", box ""; "$callerFile", box ""; "$templateLine", box 0; "$generatedLine", box 0; "$confidence", box "" ]
    for reference in inlineGraph.generatedReferences do
        setPreparedCommandParameters inlineGeneratedReferenceCommand
            [ "$id", box reference.invocationId; "$kind", box reference.referenceKind; "$value", box reference.expandedValue
              "$templateFile", box reference.templateFile; "$callerFile", box reference.callerFile
              "$templateLine", box reference.templateLine; "$generatedLine", box reference.generatedLine; "$confidence", box reference.confidence ]
        inlineGeneratedReferenceCommand.ExecuteNonQuery() |> ignore
    use inlineProblemCommand = connection.CreateCommand()
    inlineProblemCommand.Transaction <- transaction
    inlineProblemCommand.CommandText <- "INSERT OR REPLACE INTO inline_problems(invocation_id, kind, message, line) VALUES ($id, $kind, $message, $line)"
    prepareCommandParameters inlineProblemCommand
        [ "$id", box ""; "$kind", box ""; "$message", box ""; "$line", box 0 ]
    for problem in inlineGraph.problems do
        setPreparedCommandParameters inlineProblemCommand
            [ "$id", box problem.invocationId; "$kind", box problem.kind; "$message", box problem.message; "$line", box problem.line ]
        inlineProblemCommand.ExecuteNonQuery() |> ignore

    createKnowledgeIndexes connection transaction
    transaction.Commit()
    // Record the deterministic benchmark in metadata before publishing; the
    // temporary file is complete at this point and equals the final content.
    let databaseSizeBytes =
        try
            if File.Exists temporary then FileInfo(temporary).Length else 0L
        with _ -> 0L
    use baselineCommand = connection.CreateCommand()
    baselineCommand.CommandText <- "INSERT OR REPLACE INTO metadata(key, value) VALUES ('baseline', $value)"
    baselineCommand.Parameters.AddWithValue("$value", string databaseSizeBytes) |> ignore
    baselineCommand.ExecuteNonQuery() |> ignore
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
            definitionCommand.CommandText <- "SELECT id, symbol_id, entity_type, file_path, logical_path, line, end_line, origin, validate, overwrite_state, resource_scope, domain, override_path, override_strategy, provenance_kind, source_file, source_line, source_end_line, template_file, template_line, invocation_file, invocation_line, has_real_range, confidence FROM definitions"
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
                    let line = int (definitionReader.GetInt64 5)
                    let endLine = int (definitionReader.GetInt64 6)
                    let provenanceKind, sourceFile, sourceLine, sourceEndLine, templateFile, templateLine, invocationFile, invocationLine, hasRealRange, confidence =
                        definitionReader.GetString 14,
                        definitionReader.GetString 15,
                        int (definitionReader.GetInt64 16),
                        int (definitionReader.GetInt64 17),
                        stringOrNone definitionReader 18,
                        (if definitionReader.IsDBNull 19 then None else Some(int (definitionReader.GetInt64 19))),
                        stringOrNone definitionReader 20,
                        (if definitionReader.IsDBNull 21 then None else Some(int (definitionReader.GetInt64 21))),
                        definitionReader.GetInt64 22 <> 0L,
                        definitionReader.GetString 23
                    definitions.Add
                        { id = definitionReader.GetString 1
                          entityType = definitionReader.GetString 2
                          file = file
                          logicalPath = definitionReader.GetString 4
                          line = line
                          endLine = endLine
                          origin = definitionReader.GetString 7
                          validate = definitionReader.GetInt64 8 <> 0L
                          subtypes = definitionSubtypes
                          overwrite = definitionReader.GetString 9
                          resourceScope = stringOrNone definitionReader 10
                          domain = domain
                          overridePath = stringOrNone definitionReader 12
                          overrideStrategy = stringOrNone definitionReader 13
                          provenanceKind = provenanceKind
                          sourceFile = sourceFile
                          sourceLine = sourceLine
                          sourceEndLine = sourceEndLine
                          templateFile = templateFile
                          templateLine = templateLine
                          invocationFile = invocationFile
                          invocationLine = invocationLine
                          hasRealRange = hasRealRange
                          confidence = confidence }

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

let private queryCurrentProjectKnowledgeDatabase (options: QueryOptions) =
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
        let eventFactsKnownExpression = "facts_known"
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
        // Synthetic and no-real-range facts pollute intent queries with generated
        // candidates. They stay available for exact identifier matches or when a
        // caller explicitly requests derived/synthetic provenance.
        let includeSynthetic = not (identifiers.IsEmpty)
        let provenanceSelectColumns =
            ", provenance_kind, source_file, source_line, source_end_line, has_real_range, confidence, template_file, template_line, invocation_file, invocation_line"
        let provenanceOrderColumns =
            "CASE"
            + " WHEN origin = 'workspace' AND provenance_kind = 'declared' THEN 0"
            + " WHEN origin = 'workspace' AND provenance_kind = 'expanded' THEN 1"
            + " WHEN origin = 'vanilla' AND provenance_kind IN ('declared', 'expanded') THEN 2"
            + " WHEN provenance_kind IN ('derived', 'synthetic') THEN 3"
            + " ELSE 4 END, "
        let definitionProvenancePredicate =
            if includeSynthetic then None
            else Some("has_real_range <> 0 AND provenance_kind NOT IN ('synthetic', 'derived')")
        let definitionWhere =
            combineSqlPredicates [ definitionSearchPredicate; definitionDomainPredicate; definitionTypePredicate; definitionOriginPredicate; definitionProvenancePredicate ]
        // Provenance-aware ranking: workspace declared > workspace expanded >
        // vanilla declared > derived/synthetic > heuristic (never by source order).
        definitionCommand.CommandText <- "SELECT id, symbol_id, entity_type, file_path, logical_path, line, end_line, origin, validate, overwrite_state, resource_scope, domain, override_path, override_strategy" + provenanceSelectColumns + " FROM definitions" + definitionWhere + " ORDER BY " + provenanceOrderColumns + "symbol_id LIMIT $limit"
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
            let provenanceKind = definitionReader.GetString 14
            let hasRealRange = definitionReader.GetInt64 18 <> 0L
            // Exact identifier queries may surface synthetic facts; intent scans
            // never show them as ordinary declarations.
            let allowedSynthetic =
                includeSynthetic
                || (provenanceKind <> "synthetic" && provenanceKind <> "derived")
                || not options.includeProjectPatterns
            if allowedDomain domain && allowedOrigin && allowedType && allowedSynthetic && matchesTokens tokens [ symbolId; entityType; file; logicalPath; domain ] then
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
                              stringOrNone definitionReader 13 |> Option.map (fun value -> "overrideStrategy", JsonValue.String value)
                              Some("provenance", jsonRecord
                                  [ Some("kind", JsonValue.String provenanceKind)
                                    Some("sourceFile", JsonValue.String(definitionReader.GetString 15))
                                    Some("sourceLine", JsonValue.Number(decimal (definitionReader.GetInt64 16)))
                                    Some("sourceEndLine", JsonValue.Number(decimal (definitionReader.GetInt64 17)))
                                    Some("hasRealRange", JsonValue.Boolean hasRealRange)
                                    Some("confidence", JsonValue.String(definitionReader.GetString 19))
                                    if not (definitionReader.IsDBNull 20) then Some("templateFile", JsonValue.String(definitionReader.GetString 20))
                                    if not (definitionReader.IsDBNull 21) then Some("templateLine", JsonValue.Number(decimal (definitionReader.GetInt64 21)))
                                    if not (definitionReader.IsDBNull 22) then Some("invocationFile", JsonValue.String(definitionReader.GetString 22))
                                    if not (definitionReader.IsDBNull 23) then Some("invocationLine", JsonValue.Number(decimal (definitionReader.GetInt64 23))) ]) ])
                    if not identifiers.IsEmpty && seedDefinitionRanges.Count < 40 then
                        seedDefinitionRanges.Add(file, line, endLine)
        definitionReader.Close()

        // Inline instantiation is a first-class retrieval surface. Seed it by
        // template path/id, invocation id or caller, expanded symbol, or a
        // generated reference value, then return every facet for the selected
        // bounded invocation closure.
        let inlineTemplates = ResizeArray<JsonValue>()
        let inlineParameters = ResizeArray<JsonValue>()
        let inlineInvocations = ResizeArray<JsonValue>()
        let inlineArguments = ResizeArray<JsonValue>()
        let inlineExpansions = ResizeArray<JsonValue>()
        let inlineGeneratedReferences = ResizeArray<JsonValue>()
        let inlineProblems = ResizeArray<JsonValue>()
        let selectedInvocationIds = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        let selectedTemplateIds = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        if not identifiers.IsEmpty || not tokens.IsEmpty then
            use inlineSeedCommand = connection.CreateCommand()
            let inlineSeedPredicate =
                if identifiers.IsEmpty then
                    sqliteTokenPredicate inlineSeedCommand tokens
                        [ "i.invocation_id"; "i.caller_file"; "i.template_id"; "t.logical_path"; "t.file"
                          "e.expanded_symbol_id"; "g.expanded_value" ]
                else
                    sqliteIndexedIdentifierPredicate inlineSeedCommand "inlineSeed" identifiers
                        [ "i.invocation_id"; "i.caller_file"; "i.template_id"; "t.logical_path"; "t.file"
                          "e.expanded_symbol_id"; "g.expanded_value" ]
            inlineSeedCommand.CommandText <-
                "SELECT DISTINCT i.invocation_id, i.template_id FROM inline_invocations i "
                + "LEFT JOIN inline_templates t ON t.template_id = i.template_id COLLATE NOCASE "
                + "LEFT JOIN inline_expansions e ON e.invocation_id = i.invocation_id "
                + "LEFT JOIN inline_generated_references g ON g.invocation_id = i.invocation_id"
                + combineSqlPredicates [ inlineSeedPredicate ]
                + " ORDER BY i.invocation_id LIMIT $limit"
            addParameter inlineSeedCommand "$limit" (box limit)
            use inlineSeedReader = inlineSeedCommand.ExecuteReader()
            while inlineSeedReader.Read() do
                selectedInvocationIds.Add(inlineSeedReader.GetString 0) |> ignore
                selectedTemplateIds.Add(inlineSeedReader.GetString 1) |> ignore
            inlineSeedReader.Close()

            // A template may have no current callers, so query template seeds
            // independently instead of requiring an invocation join.
            use inlineTemplateSeedCommand = connection.CreateCommand()
            let templateSeedPredicate =
                if identifiers.IsEmpty then
                    sqliteTokenPredicate inlineTemplateSeedCommand tokens [ "template_id"; "logical_path"; "file" ]
                else
                    sqliteIndexedIdentifierPredicate inlineTemplateSeedCommand "inlineTemplateSeed" identifiers [ "template_id"; "logical_path"; "file" ]
            inlineTemplateSeedCommand.CommandText <-
                "SELECT template_id FROM inline_templates"
                + combineSqlPredicates [ templateSeedPredicate ]
                + " ORDER BY template_id LIMIT $limit"
            addParameter inlineTemplateSeedCommand "$limit" (box limit)
            use inlineTemplateSeedReader = inlineTemplateSeedCommand.ExecuteReader()
            while inlineTemplateSeedReader.Read() do selectedTemplateIds.Add(inlineTemplateSeedReader.GetString 0) |> ignore
            inlineTemplateSeedReader.Close()

            let invocationIds = selectedInvocationIds |> Seq.sort |> Seq.truncate limit |> Seq.toList
            let templateIds = selectedTemplateIds |> Seq.sort |> Seq.truncate limit |> Seq.toList

            if not templateIds.IsEmpty then
                use templateCommand = connection.CreateCommand()
                let predicate = sqliteValueSetPredicate templateCommand "selectedTemplate" templateIds "template_id"
                templateCommand.CommandText <- "SELECT template_id, logical_path, file, line, content_hash FROM inline_templates" + combineSqlPredicates [ predicate ] + " ORDER BY template_id"
                use reader = templateCommand.ExecuteReader()
                while reader.Read() do
                    inlineTemplates.Add(jsonRecord
                        [ Some("templateId", JsonValue.String(reader.GetString 0))
                          Some("logicalPath", JsonValue.String(reader.GetString 1))
                          Some("file", JsonValue.String(reader.GetString 2))
                          Some("line", JsonValue.Number(decimal (reader.GetInt64 3)))
                          Some("contentHash", JsonValue.String(reader.GetString 4)) ])
                reader.Close()

                use parameterCommand = connection.CreateCommand()
                let predicate = sqliteValueSetPredicate parameterCommand "selectedParameterTemplate" templateIds "template_id"
                parameterCommand.CommandText <- "SELECT template_id, name, usage_kind, usage_kinds, inferred_type, required, occurrences FROM inline_parameters" + combineSqlPredicates [ predicate ] + " ORDER BY template_id, name"
                use reader = parameterCommand.ExecuteReader()
                while reader.Read() do
                    inlineParameters.Add(jsonRecord
                        [ Some("templateId", JsonValue.String(reader.GetString 0))
                          Some("name", JsonValue.String(reader.GetString 1))
                          Some("usageKind", JsonValue.String(reader.GetString 2))
                          Some("usageKinds", JsonValue.Parse(reader.GetString 3))
                          Some("inferredType", JsonValue.String(reader.GetString 4))
                          Some("required", JsonValue.Boolean(reader.GetInt64 5 <> 0L))
                          Some("occurrences", JsonValue.Number(decimal (reader.GetInt64 6))) ])
                reader.Close()

            if not invocationIds.IsEmpty then
                let readInvocationFacet commandPrefix selectSql addRow =
                    use command = connection.CreateCommand()
                    let predicate = sqliteValueSetPredicate command commandPrefix invocationIds "invocation_id"
                    command.CommandText <- selectSql + combineSqlPredicates [ predicate ] + " ORDER BY invocation_id"
                    use reader = command.ExecuteReader()
                    while reader.Read() do addRow reader
                    reader.Close()

                readInvocationFacet "selectedInvocation"
                    "SELECT invocation_id, caller_file, caller_line, template_id, enclosing_definition FROM inline_invocations"
                    (fun reader ->
                        inlineInvocations.Add(jsonRecord
                            [ Some("invocationId", JsonValue.String(reader.GetString 0))
                              Some("callerFile", JsonValue.String(reader.GetString 1))
                              Some("callerLine", JsonValue.Number(decimal (reader.GetInt64 2)))
                              Some("templateId", JsonValue.String(reader.GetString 3))
                              stringOrNone reader 4 |> Option.map (fun value -> "enclosingDefinition", JsonValue.String value) ]))
                readInvocationFacet "selectedArgument"
                    "SELECT invocation_id, name, raw_value, resolved_value, value_kind FROM inline_arguments"
                    (fun reader ->
                        inlineArguments.Add(jsonRecord
                            [ Some("invocationId", JsonValue.String(reader.GetString 0)); Some("name", JsonValue.String(reader.GetString 1))
                              Some("rawValue", JsonValue.String(reader.GetString 2)); Some("resolvedValue", JsonValue.String(reader.GetString 3))
                              Some("valueKind", JsonValue.String(reader.GetString 4)) ]))
                readInvocationFacet "selectedExpansion"
                    "SELECT invocation_id, expanded_symbol_id, entity_type, template_file, caller_file, template_line, generated_line, confidence FROM inline_expansions"
                    (fun reader ->
                        inlineExpansions.Add(jsonRecord
                            [ Some("invocationId", JsonValue.String(reader.GetString 0)); Some("expandedSymbolId", JsonValue.String(reader.GetString 1))
                              Some("entityType", JsonValue.String(reader.GetString 2)); Some("templateFile", JsonValue.String(reader.GetString 3))
                              Some("callerFile", JsonValue.String(reader.GetString 4)); Some("templateLine", JsonValue.Number(decimal (reader.GetInt64 5)))
                              Some("generatedLine", JsonValue.Number(decimal (reader.GetInt64 6))); Some("confidence", JsonValue.String(reader.GetString 7)) ]))
                readInvocationFacet "selectedGeneratedReference"
                    "SELECT invocation_id, reference_kind, expanded_value, template_file, caller_file, template_line, generated_line, confidence FROM inline_generated_references"
                    (fun reader ->
                        inlineGeneratedReferences.Add(jsonRecord
                            [ Some("invocationId", JsonValue.String(reader.GetString 0)); Some("referenceKind", JsonValue.String(reader.GetString 1))
                              Some("expandedValue", JsonValue.String(reader.GetString 2)); Some("templateFile", JsonValue.String(reader.GetString 3))
                              Some("callerFile", JsonValue.String(reader.GetString 4)); Some("templateLine", JsonValue.Number(decimal (reader.GetInt64 5)))
                              Some("generatedLine", JsonValue.Number(decimal (reader.GetInt64 6))); Some("confidence", JsonValue.String(reader.GetString 7)) ]))
                readInvocationFacet "selectedInlineProblem"
                    "SELECT invocation_id, kind, message, line FROM inline_problems"
                    (fun reader ->
                        inlineProblems.Add(jsonRecord
                            [ Some("invocationId", JsonValue.String(reader.GetString 0)); Some("kind", JsonValue.String(reader.GetString 1))
                              Some("message", JsonValue.String(reader.GetString 2)); Some("line", JsonValue.Number(decimal (reader.GetInt64 3))) ]))

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
            let edgeSelectColumns =
                "source_kind, source_id, target_event_id, edge_type, label, source_file, line, confidence, call_operator, phase, delay, condition_path, scope_map, source_scope, target_scope"
            edgeCommand.CommandText <- "SELECT " + edgeSelectColumns + " FROM event_edges" + combineSqlPredicates [ edgeSearchPredicate ] + " LIMIT $limit"
            addParameter edgeCommand "$limit" (box (max 500 (limit * 20)))
            use edgeReader = edgeCommand.ExecuteReader()
            while edgeReader.Read() && eventEdges.Count < limit do
                let sourceId = edgeReader.GetString 1
                let targetId = edgeReader.GetString 2
                let edgeType = edgeReader.GetString 3
                if matchesTokens tokens [ sourceId; targetId; edgeType; edgeReader.GetString 0 ] then
                    if edgeReader.GetString 0 = "event" then relatedEventIds.Add sourceId |> ignore
                    relatedEventIds.Add targetId |> ignore
                    let edgeBase =
                        jsonRecord
                            [ Some("sourceKind", JsonValue.String(edgeReader.GetString 0)); Some("sourceId", JsonValue.String sourceId)
                              Some("targetEventId", JsonValue.String targetId); Some("edgeType", JsonValue.String edgeType)
                              Some("direction", JsonValue.String "source_to_target")
                              Some("causality", JsonValue.String "directed_typed_reference")
                              stringOrNone edgeReader 4 |> Option.map (fun value -> "label", JsonValue.String value)
                              Some("sourceFile", JsonValue.String(edgeReader.GetString 5)); Some("line", JsonValue.Number(decimal (edgeReader.GetInt64 6)))
                              Some("confidence", JsonValue.String(edgeReader.GetString 7)) ]
                    let context =
                        [ stringOrNone edgeReader 8 |> Option.map (fun value -> "callOperator", JsonValue.String value)
                          stringOrNone edgeReader 9 |> Option.map (fun value -> "phase", JsonValue.String value)
                          stringOrNone edgeReader 10 |> Option.map (fun value -> "delay", JsonValue.String value)
                          stringOrNone edgeReader 11 |> Option.map (fun value -> "conditionPath", JsonValue.String value)
                          stringOrNone edgeReader 12 |> Option.map (fun value -> "scopeMap", JsonValue.String value)
                          stringOrNone edgeReader 13 |> Option.map (fun value -> "sourceScope", JsonValue.String value)
                          stringOrNone edgeReader 14 |> Option.map (fun value -> "targetScope", JsonValue.String value) ]
                        |> List.choose id
                    let fields = edgeBase.Properties() |> Array.toList |> List.map (fun (key, value) -> key, value)
                    eventEdges.Add(JsonValue.Record(Array.ofList (fields @ context)))
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

        // Definition stacks: concrete candidates, origins, logical paths and
        // override strategy, plus the resolved winner. Only surfaced for exact
        // identifier queries so intent scans stay compact.
        let definitionStacksResult = ResizeArray<JsonValue>()
        if not identifiers.IsEmpty then
            use stackCommand = connection.CreateCommand()
            let stackSearchPredicate =
                sqliteIndexedIdentifierPredicate stackCommand "stackSymbol" identifiers [ "ds.symbol_id" ]
            stackCommand.CommandText <-
                "SELECT ds.entity_type, ds.symbol_id, ds.resolution, d.symbol_id, d.entity_type, d.origin, d.logical_path, d.override_strategy, d.overwrite_state, sc.candidate_order, d.file_path, d.line, sc.is_active "
                + "FROM definition_stacks ds JOIN stack_candidates sc ON sc.stack_id = ds.id "
                + "JOIN definitions d ON d.id = sc.definition_id "
                + combineSqlPredicates [ stackSearchPredicate ]
                + " ORDER BY ds.entity_type, ds.symbol_id, sc.candidate_order LIMIT 500"
            use stackReader = stackCommand.ExecuteReader()
            let current = ResizeArray<JsonValue>()
            let mutable currentKey = ""
            let mutable currentEntityType = ""
            let mutable currentSymbolId = ""
            let mutable currentResolution = ""
            let mutable currentWinner: JsonValue option = None
            let flushStack () =
                if current.Count > 0 then
                    let isAmbiguous = currentResolution = "ambiguous"
                    definitionStacksResult.Add(
                        jsonRecord
                            [ Some("entityType", JsonValue.String currentEntityType)
                              Some("id", JsonValue.String currentSymbolId)
                              Some("resolution", JsonValue.String currentResolution)
                              Some("ambiguous", JsonValue.Boolean isAmbiguous)
                              if isAmbiguous then Some("ambiguousReason", JsonValue.String "No unique CWTools winner or deterministic override mode was available.") else None
                              currentWinner |> Option.map (fun winner -> "winner", winner)
                              Some("definitions", JsonValue.Array(current.ToArray()))
                              Some("losers", JsonValue.Array(
                                  current
                                  |> Seq.mapi (fun index candidate -> index, candidate)
                                  |> Seq.choose (fun (index, candidate) ->
                                      match currentWinner with
                                      | Some _ when candidate <> currentWinner.Value -> Some candidate
                                      | _ -> None)
                                  |> Seq.toArray)) ])
                current.Clear()
                currentWinner <- None
            while stackReader.Read() do
                let entityType = stackReader.GetString 0
                let symbolId = stackReader.GetString 1
                let resolution = stackReader.GetString 2
                let key = entityType.ToLowerInvariant() + "|" + symbolId.ToLowerInvariant()
                if key <> currentKey then
                    flushStack ()
                    currentKey <- key
                    currentEntityType <- entityType
                    currentSymbolId <- symbolId
                    currentResolution <- resolution
                let candidate =
                    let candidateOrigin = stackReader.GetString 5
                    let candidateFile = stackReader.GetString 10
                    let loadOrderIndex, loadOrderRoot = configuredLoadOrderForFile candidateOrigin candidateFile
                    jsonRecord
                        [ Some("symbolId", JsonValue.String(stackReader.GetString 3))
                          Some("entityType", JsonValue.String(stackReader.GetString 4))
                          Some("origin", JsonValue.String candidateOrigin)
                          Some("loadOrderIndex", JsonValue.Number(decimal loadOrderIndex))
                          loadOrderRoot |> Option.map (fun value -> "loadOrderRoot", JsonValue.String value)
                          Some("logicalPath", JsonValue.String(stackReader.GetString 6))
                          stringOrNone stackReader 7 |> Option.map (fun value -> "overrideStrategy", JsonValue.String value)
                          Some("overwriteState", JsonValue.String(stackReader.GetString 8))
                          Some("candidateOrder", JsonValue.Number(decimal (stackReader.GetInt64 9)))
                          Some("file", JsonValue.String candidateFile)
                          Some("line", JsonValue.Number(decimal (stackReader.GetInt64 11))) ]
                current.Add candidate
                if stackReader.GetInt64 12 <> 0L then currentWinner <- Some candidate
            flushStack ()

        jsonRecord
            [ Some("ok", JsonValue.Boolean true)
              Some("status", JsonValue.String(getMetadata "status" "stale"))
              Some("source", JsonValue.String "cwtools-project-knowledge-sqlite")
              Some("schemaVersion", JsonValue.Number(decimal KnowledgeSchemaVersion))
              Some("capabilityVersions", capabilityVersionsJson)
              Some("capabilityStatus", capabilityStatusJson)
              Some("databasePath", JsonValue.String(normalizePath databasePath))
              Some("generatedAt", JsonValue.String(getMetadata "generated_at" ""))
              Some("game", JsonValue.String(getMetadata "game" "unknown"))
              Some("graphVersion", JsonValue.Number(decimal (Int64.Parse(getMetadata "graph_version" "0"))))
              Some("coverage", jsonRecord
                [ Some("definitionsConsidered", JsonValue.Number(decimal (Int64.Parse(getMetadata "definition_count" "0"))))
                  Some("definitionsIndexed", JsonValue.Number(decimal (Int64.Parse(getMetadata "definition_count" "0"))))
                  Some("filesConsidered", JsonValue.Number(decimal (Int64.Parse(getMetadata "topology_file_count" "0"))))
                  Some("filesIndexed", JsonValue.Number(decimal (Int64.Parse(getMetadata "topology_file_count" "0"))))
                  Some("edgesConsidered", JsonValue.Number(decimal (Int64.Parse(getMetadata "topology_edge_count" "0"))))
                  Some("edgesIndexed", JsonValue.Number(decimal (Int64.Parse(getMetadata "topology_edge_count" "0"))))
                  Some("truncated", JsonValue.Boolean(String.Equals(getMetadata "topology_truncated" "false", "true", StringComparison.OrdinalIgnoreCase)))
                  Some("staleReasons", jsonStringArray
                    [ if not (String.IsNullOrWhiteSpace(getMetadata "status" "stale")) && getMetadata "status" "stale" <> "ready" && getMetadata "status" "stale" <> "partial" then yield "knowledge_" + getMetadata "status" "stale" ])
                  Some("unsupportedConstructs", jsonStringArray
                    [ if Int64.Parse(getMetadata "graph_version" "0") = 0L then yield "graph_version_unknown" ]) ])
              Some("retrieval", jsonRecord
                [ Some("strategy", JsonValue.String(if identifiers.IsEmpty then "bounded_token_scan" else "indexed_graph"))
                  Some("seedIdentifiers", jsonStringArray identifiers)
                  Some("seedDefinitions", JsonValue.Number(decimal seedDefinitionRanges.Count))
                  Some("evidenceReturned", JsonValue.Number(decimal evidence.Count))
                  Some("eventNodesReturned", JsonValue.Number(decimal eventNodes.Count))
                  Some("eventEdgesReturned", JsonValue.Number(decimal eventEdges.Count))
                  Some("eventLogicReturned", JsonValue.Number(decimal eventLogic.Count))
                  Some("inlineTemplatesReturned", JsonValue.Number(decimal inlineTemplates.Count))
                  Some("inlineInvocationsReturned", JsonValue.Number(decimal inlineInvocations.Count))
                  Some("inlineExpansionsReturned", JsonValue.Number(decimal inlineExpansions.Count)) ])
              Some("domains", jsonStringArray (capabilities |> Seq.map (fun item -> item.GetProperty("domain").AsString())))
              Some("capabilities", JsonValue.Array(capabilities.ToArray()))
              Some("evidence", JsonValue.Array(evidence.ToArray()))
              Some("eventGraph", jsonRecord
                [ Some("nodes", JsonValue.Array(eventNodes.ToArray()))
                  Some("edges", JsonValue.Array(eventEdges.ToArray()))
                  Some("logic", JsonValue.Array(eventLogic.ToArray()))
                  Some("incomingCoverage", JsonValue.String incomingCoverage)
                  Some("causalityPolicy", JsonValue.String "Only directed typed references and explicit execution facts are evidence; IDs, source order, layout, and missing edges are not.") ])
              Some("inlineGraph", jsonRecord
                [ Some("templates", JsonValue.Array(inlineTemplates.ToArray()))
                  Some("parameters", JsonValue.Array(inlineParameters.ToArray()))
                  Some("invocations", JsonValue.Array(inlineInvocations.ToArray()))
                  Some("arguments", JsonValue.Array(inlineArguments.ToArray()))
                  Some("expansions", JsonValue.Array(inlineExpansions.ToArray()))
                  Some("generatedReferences", JsonValue.Array(inlineGeneratedReferences.ToArray()))
                  Some("problems", JsonValue.Array(inlineProblems.ToArray()))
                  Some("truncated", JsonValue.Boolean(
                    selectedInvocationIds.Count > inlineInvocations.Count || selectedTemplateIds.Count > inlineTemplates.Count))
                  Some("seedKinds", jsonStringArray [ "template_path"; "template_id"; "caller_file"; "invocation_id"; "expanded_symbol_id"; "generated_reference" ]) ])
              Some("unresolved", JsonValue.Array(unresolved.ToArray()))
              Some("definitionStacks", JsonValue.Array(definitionStacksResult.ToArray()))
              Some("requiredNextChecks", jsonStringArray
                [ "Use query_cwt_schema/query_rules/query_scope for legality before writing."
                  "For shader evidence, use query_shader_compile_unit/query_shader_callers/explain_shader_reachability before editing."
                  "For interface shaders, trace gui_uses_interface_sprite -> interface_sprite_selects_shader_file and verify renderer inputs/subtype before editing effectFile or Effect names."
                  "Read exact source blocks referenced by event structure and logic evidence."
                  "Verify event scope bridges and state lifecycles before approving complex blueprints."
                  "Never infer event or entity causality from numeric IDs, file/source order, proximity, graph layout, or a missing incoming edge." ]) ]

let queryProjectKnowledgeDatabase (options: QueryOptions) =
    let databasePath = Path.GetFullPath options.databasePath
    if not (File.Exists databasePath) then
        queryCurrentProjectKnowledgeDatabase options
    else
        try
            let foundVersion =
                let connectionString = SqliteConnectionStringBuilder(DataSource = databasePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false).ToString()
                use connection = new SqliteConnection(connectionString)
                connection.Open()
                let metadata = readMetadata connection
                match metadata.TryGetValue "schema_version" with
                | true, value -> match Int32.TryParse value with true, parsed -> parsed | _ -> 0
                | _ -> 0
            if foundVersion <> KnowledgeSchemaVersion then
                jsonRecord
                    [ Some("ok", JsonValue.Boolean false)
                      Some("status", JsonValue.String "stale")
                      Some("rebuildRequired", JsonValue.Boolean true)
                      Some("foundSchemaVersion", JsonValue.Number(decimal foundVersion))
                      Some("currentSchemaVersion", JsonValue.Number(decimal KnowledgeSchemaVersion))
                      Some("databasePath", JsonValue.String(normalizePath databasePath))
                      Some("error", JsonValue.String $"Project knowledge schema V{foundVersion} is obsolete. Rebuild the knowledge database with the current V{KnowledgeSchemaVersion} extension.") ]
            else
                queryCurrentProjectKnowledgeDatabase options
        with error ->
            jsonRecord
                [ Some("ok", JsonValue.Boolean false)
                  Some("status", JsonValue.String "error")
                  Some("rebuildRequired", JsonValue.Boolean true)
                  Some("currentSchemaVersion", JsonValue.Number(decimal KnowledgeSchemaVersion))
                  Some("databasePath", JsonValue.String(normalizePath databasePath))
                  Some("error", JsonValue.String $"Project knowledge schema could not be verified: {error.Message}. Rebuild the knowledge database.") ]

let private exportProjectKnowledgeRebuild shouldCancel (activeGame: string) (projectRoots: string list) (rawOptions: ExportOptions) (runtime: RuntimeMetadata) (game: IGame<'T>) =
    let checkCancelled () = if shouldCancel () then raise (OperationCanceledException("Project knowledge export was cancelled."))
    checkCancelled ()
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
    checkCancelled ()
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
    checkCancelled ()
    let freshTopology = collectTopology projectRoots collectionOptions shaderModel game
    checkCancelled ()
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
    // from the previous current-schema database before stacks and event relationships rebuild.
    let options = { collectionOptions with domains = []; changedFiles = []; generationMode = generationMode }
    let definitions = selectDefinitions options availableDefinitions
    let domains = domainSummaries options definitions
    let eventGraph = collectEventGraph options availableDefinitions topology game
    checkCancelled ()
    let inlineGraph = InlineGraph.collectInlineGraphCancellable shouldCancel (game.AllEntities())
    checkCancelled ()
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
        let exportStartedAt = DateTimeOffset.UtcNow
        let storedPath, generatedAt =
            writeKnowledgeDatabase databasePath activeGame projectRoots options publishedRuntime definitions topology eventGraph inlineGraph (game :> IGame) warnings
        let baseline = baselineJson storedPath definitions topology eventGraph generatedAt exportStartedAt
        let coverage = coverageJson options runtime availableDefinitions topology (definitions.Length < availableDefinitions.Length || topology.truncated)
        jsonRecord
            [ Some("ok", JsonValue.Boolean true)
              Some("status", JsonValue.String publishedRuntime.status)
              Some("source", JsonValue.String "cwtools-project-knowledge-sqlite")
              Some("schemaVersion", JsonValue.Number(decimal KnowledgeSchemaVersion))
              Some("capabilityVersions", capabilityVersionsJson)
              Some("capabilityStatus", capabilityStatusJson)
              Some("game", JsonValue.String activeGame)
              Some("generatedAtUnixMs", JsonValue.Number(decimal (generatedAt.ToUnixTimeMilliseconds())))
              Some("graphVersion", JsonValue.Number(decimal runtime.graphVersion))
              Some("completeExport", JsonValue.Boolean options.completeExport)
              Some("projectRoots", jsonStringArray projectRoots)
              Some("databasePath", JsonValue.String(normalizePath storedPath))
              Some("generationMode", JsonValue.String generationMode)
              Some("domains", JsonValue.Array(compactDomainSummaries definitions))
              Some("coverage", coverage)
              Some("baseline", baseline)
              Some("counts", jsonRecord
                [ Some("definitions", JsonValue.Number(decimal definitions.Length))
                  Some("availableDefinitions", JsonValue.Number(decimal availableDefinitions.Length))
                  Some("workspaceDefinitions", JsonValue.Number(decimal (definitions |> List.filter (fun item -> item.origin = "workspace") |> List.length)))
                  Some("dependencyDefinitions", JsonValue.Number(decimal (definitions |> List.filter (fun item -> item.origin = "dependency") |> List.length)))
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
              Some("schemaVersion", JsonValue.Number(decimal KnowledgeSchemaVersion))
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

let private obsoleteKnowledgeSchemaError foundVersion =
    jsonRecord
        [ Some("ok", JsonValue.Boolean false)
          Some("status", JsonValue.String "stale")
          Some("rebuildRequired", JsonValue.Boolean true)
          Some("foundSchemaVersion", JsonValue.Number(decimal foundVersion))
          Some("currentSchemaVersion", JsonValue.Number(decimal KnowledgeSchemaVersion))
          Some("error", JsonValue.String $"Project knowledge schema V{foundVersion} is obsolete. A full V{KnowledgeSchemaVersion} rebuild is required.") ]

let private tryIncrementalProjectKnowledgeExport
    (shouldCancel: unit -> bool)
    (activeGame: string)
    (projectRoots: string list)
    (rawOptions: ExportOptions)
    (runtime: RuntimeMetadata)
    (game: IGame<'T>)
    =
    let checkCancelled () = if shouldCancel () then raise (OperationCanceledException("Incremental project knowledge export was cancelled."))
    checkCancelled ()
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
                    let incrementalStartedAt = DateTimeOffset.UtcNow
                    let collectionOptions =
                        { options with
                            domains = []
                            changedFiles = changedFiles
                            generationMode = "incremental" }
                    let resources = resourceFacts (game :> IGame)
                    checkCancelled ()
                    let freshDefinitions = collectDefinitions (game :> IGame) projectRoots resources None collectionOptions
                    checkCancelled ()
                    let freshTopology = collectTopology projectRoots collectionOptions None game
                    checkCancelled ()
                    let freshInlineGraph = InlineGraph.collectInlineGraphCancellable shouldCancel (game.AllEntities())
                    checkCancelled ()
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
                    if schemaVersion <> string KnowledgeSchemaVersion then
                        let foundVersion = match Int32.TryParse schemaVersion with true, value -> value | _ -> 0
                        Some(obsoleteKnowledgeSchemaError foundVersion)
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
CREATE TEMP TABLE affected_inline_templates(template_id TEXT PRIMARY KEY COLLATE NOCASE);
CREATE TEMP TABLE affected_inline_invocations(invocation_id TEXT PRIMARY KEY COLLATE NOCASE);
"""
                        use affectedInlineTemplateCommand = connection.CreateCommand()
                        affectedInlineTemplateCommand.Transaction <- transaction
                        affectedInlineTemplateCommand.CommandText <- "INSERT OR IGNORE INTO affected_inline_templates(template_id) VALUES ($template)"
                        prepareCommandParameters affectedInlineTemplateCommand [ "$template", box "" ]
                        let freshChangedTemplates =
                            freshInlineGraph.templates
                            |> List.filter (fun template -> changedFiles |> List.exists (fun file -> normalizeFileKey file = normalizeFileKey template.file))
                        let freshChangedById = freshChangedTemplates |> Seq.map (fun template -> template.templateId, template) |> dict
                        use oldInlineTemplateCommand = connection.CreateCommand()
                        oldInlineTemplateCommand.Transaction <- transaction
                        oldInlineTemplateCommand.CommandText <- $"SELECT t.template_id, t.content_hash FROM inline_templates t JOIN changed_paths c ON t.file = c.path {pathComparison}"
                        use oldInlineTemplateReader = oldInlineTemplateCommand.ExecuteReader()
                        let oldChangedTemplates = ResizeArray<string * string>()
                        while oldInlineTemplateReader.Read() do
                            oldChangedTemplates.Add(oldInlineTemplateReader.GetString 0, oldInlineTemplateReader.GetString 1)
                        oldInlineTemplateReader.Close()
                        for templateId, oldHash in oldChangedTemplates do
                            match freshChangedById.TryGetValue templateId with
                            | true, fresh when String.Equals(oldHash, fresh.contentHash, StringComparison.OrdinalIgnoreCase) -> ()
                            | _ ->
                                setPreparedCommandParameters affectedInlineTemplateCommand [ "$template", box templateId ]
                                affectedInlineTemplateCommand.ExecuteNonQuery() |> ignore
                        let oldChangedIds = oldChangedTemplates |> Seq.map fst |> HashSet<string>
                        for template in freshChangedTemplates do
                            if not (oldChangedIds.Contains template.templateId) then
                                setPreparedCommandParameters affectedInlineTemplateCommand [ "$template", box template.templateId ]
                                affectedInlineTemplateCommand.ExecuteNonQuery() |> ignore
                        executeSql connection (Some transaction) $"""
WITH RECURSIVE reverse_callers(template_id) AS (
  SELECT template_id FROM affected_inline_templates
  UNION
  SELECT caller.template_id
  FROM inline_invocations invocation
  JOIN inline_templates caller ON caller.file = invocation.caller_file {pathComparison}
  JOIN reverse_callers affected ON lower(invocation.template_id) = lower(affected.template_id)
)
INSERT OR IGNORE INTO affected_inline_templates(template_id)
SELECT template_id FROM reverse_callers;
INSERT OR IGNORE INTO affected_inline_invocations(invocation_id)
SELECT invocation.invocation_id
FROM inline_invocations invocation
WHERE EXISTS (SELECT 1 FROM changed_paths c WHERE invocation.caller_file = c.path {pathComparison})
   OR EXISTS (SELECT 1 FROM affected_inline_templates t WHERE lower(t.template_id) = lower(invocation.template_id));
"""

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
DELETE FROM inline_problems WHERE invocation_id IN (SELECT invocation_id FROM affected_inline_invocations);
DELETE FROM inline_generated_references WHERE invocation_id IN (SELECT invocation_id FROM affected_inline_invocations);
DELETE FROM inline_expansions WHERE invocation_id IN (SELECT invocation_id FROM affected_inline_invocations);
DELETE FROM inline_arguments WHERE invocation_id IN (SELECT invocation_id FROM affected_inline_invocations);
DELETE FROM inline_invocations WHERE invocation_id IN (SELECT invocation_id FROM affected_inline_invocations);
DELETE FROM inline_parameters WHERE template_id IN (SELECT template_id FROM affected_inline_templates);
DELETE FROM inline_templates WHERE template_id IN (SELECT template_id FROM affected_inline_templates);
DELETE FROM event_edges
WHERE lower(target_event_id) IN (
  SELECT event_id FROM affected_event_ids
  WHERE event_id NOT IN (SELECT event_id FROM fresh_event_ids)
);
"""
                        use definitionCommand = connection.CreateCommand()
                        definitionCommand.Transaction <- transaction
                        definitionCommand.CommandText <- "INSERT INTO definitions(symbol_id, entity_type, file_path, logical_path, line, end_line, origin, validate, overwrite_state, resource_scope, domain, override_path, override_strategy, provenance_kind, source_file, source_line, source_end_line, template_file, template_line, invocation_file, invocation_line, has_real_range, confidence) VALUES ($symbol, $type, $file, $logical, $line, $end, $origin, $validate, $overwrite, $scope, $domain, $overridePath, $overrideStrategy, $provenance, $sourceFile, $sourceLine, $sourceEndLine, $templateFile, $templateLine, $invocationFile, $invocationLine, $hasRealRange, $confidence) RETURNING id"
                        prepareCommandParameters definitionCommand
                            [ "$symbol", box ""; "$type", box ""; "$file", box ""; "$logical", box ""; "$line", box 0; "$end", box 0
                              "$origin", box ""; "$validate", box 0; "$overwrite", box ""; "$scope", box ""; "$domain", box ""
                              "$overridePath", box ""; "$overrideStrategy", box ""; "$provenance", box ""; "$sourceFile", box ""
                              "$sourceLine", box 0; "$sourceEndLine", box 0; "$templateFile", box ""; "$templateLine", box 0
                              "$invocationFile", box ""; "$invocationLine", box 0; "$hasRealRange", box 0; "$confidence", box "" ]
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
                                  "$overridePath", box (definition.overridePath |> Option.toObj); "$overrideStrategy", box (definition.overrideStrategy |> Option.toObj)
                                  "$provenance", box definition.provenanceKind; "$sourceFile", box (normalizePath definition.sourceFile)
                                  "$sourceLine", box definition.sourceLine; "$sourceEndLine", box definition.sourceEndLine
                                  "$templateFile", box (definition.templateFile |> Option.toObj); "$templateLine", box (definition.templateLine |> Option.map box |> Option.toObj)
                                  "$invocationFile", box (definition.invocationFile |> Option.toObj); "$invocationLine", box (definition.invocationLine |> Option.map box |> Option.toObj)
                                  "$hasRealRange", box (if definition.hasRealRange then 1 else 0); "$confidence", box definition.confidence ]
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
                        eventEdgeCommand.CommandText <- "INSERT INTO event_edges(source_kind, source_id, target_event_id, edge_type, label, source_file, line, confidence, call_operator, phase, delay, condition_path, scope_map, source_scope, target_scope) VALUES ($kind, $source, $target, $type, $label, $file, $line, $confidence, $callOperator, $phase, $delay, $conditionPath, $scopeMap, $sourceScope, $targetScope)"
                        prepareCommandParameters eventEdgeCommand
                            [ "$kind", box ""; "$source", box ""; "$target", box ""; "$type", box ""; "$label", box ""; "$file", box ""
                              "$line", box 0; "$confidence", box ""; "$callOperator", box ""; "$phase", box ""; "$delay", box ""
                              "$conditionPath", box ""; "$scopeMap", box ""; "$sourceScope", box ""; "$targetScope", box "" ]
                        for edge in eventGraph.edges do
                            setPreparedCommandParameters eventEdgeCommand
                                [ "$kind", box edge.sourceKind; "$source", box edge.sourceId; "$target", box edge.targetEventId
                                  "$type", box edge.edgeType; "$label", box (edge.label |> Option.toObj); "$file", box edge.sourceFile
                                  "$line", box edge.line; "$confidence", box edge.confidence
                                  "$callOperator", box (edge.callOperator |> Option.toObj); "$phase", box (edge.phase |> Option.toObj)
                                  "$delay", box (edge.delay |> Option.toObj); "$conditionPath", box (edge.conditionPath |> Option.toObj)
                                  "$scopeMap", box (edge.scopeMap |> Option.toObj); "$sourceScope", box (edge.sourceScope |> Option.toObj)
                                  "$targetScope", box (edge.targetScope |> Option.toObj) ]
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
                        for item in eventGraph.stateAccesses do
                            setPreparedCommandParameters eventLogicCommand
                                [ "$event", box item.eventId; "$type", box item.relationType; "$subject", box item.subject
                                  "$scope", box (item.scope |> Option.toObj); "$phase", box item.phase; "$file", box item.sourceFile
                                  "$line", box item.line; "$details", box (item.details |> Option.toObj) ]
                            eventLogicCommand.ExecuteNonQuery() |> ignore

                        let readAffectedSet tableName columnName =
                            use command = connection.CreateCommand()
                            command.Transaction <- transaction
                            command.CommandText <- sprintf "SELECT %s FROM %s" columnName tableName
                            use reader = command.ExecuteReader()
                            let values = HashSet<string>(StringComparer.OrdinalIgnoreCase)
                            while reader.Read() do values.Add(reader.GetString 0) |> ignore
                            values
                        let affectedInlineTemplates = readAffectedSet "affected_inline_templates" "template_id"
                        let freshTemplateByFile =
                            freshInlineGraph.templates
                            |> Seq.map (fun template -> normalizeFileKey template.file, template.templateId)
                            |> dict
                        let callerChanged callerFile =
                            changedFiles |> List.exists (fun file -> normalizeFileKey file = normalizeFileKey callerFile)
                        let invocationAffected (invocation: InlineGraph.InlineInvocationFact) =
                            callerChanged invocation.callerFile
                            || affectedInlineTemplates.Contains invocation.templateId
                            || match freshTemplateByFile.TryGetValue(normalizeFileKey invocation.callerFile) with
                               | true, callerTemplate -> affectedInlineTemplates.Contains callerTemplate
                               | _ -> false
                        let affectedFreshInvocationIds =
                            freshInlineGraph.invocations
                            |> Seq.filter invocationAffected
                            |> Seq.map _.invocationId
                            |> HashSet<string>

                        // Refresh only the changed template/caller reverse closure.
                        // Unrelated inline facts retain their rows and hashes.
                        use inlineTemplateCommand = connection.CreateCommand()
                        inlineTemplateCommand.Transaction <- transaction
                        inlineTemplateCommand.CommandText <- "INSERT OR REPLACE INTO inline_templates(template_id, logical_path, file, line, content_hash) VALUES ($id, $logical, $file, $line, $hash)"
                        prepareCommandParameters inlineTemplateCommand
                            [ "$id", box ""; "$logical", box ""; "$file", box ""; "$line", box 0; "$hash", box "" ]
                        for template in freshInlineGraph.templates |> Seq.filter (fun template -> affectedInlineTemplates.Contains template.templateId) do
                            setPreparedCommandParameters inlineTemplateCommand
                                [ "$id", box template.templateId; "$logical", box template.logicalPath; "$file", box template.file
                                  "$line", box template.line; "$hash", box template.contentHash ]
                            inlineTemplateCommand.ExecuteNonQuery() |> ignore
                        use inlineParameterCommand = connection.CreateCommand()
                        inlineParameterCommand.Transaction <- transaction
                        inlineParameterCommand.CommandText <- "INSERT OR REPLACE INTO inline_parameters(template_id, name, usage_kind, usage_kinds, inferred_type, required, occurrences) VALUES ($id, $name, $kind, $kinds, $inferred, $required, $occurrences)"
                        prepareCommandParameters inlineParameterCommand
                            [ "$id", box ""; "$name", box ""; "$kind", box ""; "$kinds", box ""; "$inferred", box ""; "$required", box 0; "$occurrences", box 0 ]
                        for parameter in freshInlineGraph.parameters |> Seq.filter (fun parameter -> affectedInlineTemplates.Contains parameter.templateId) do
                            setPreparedCommandParameters inlineParameterCommand
                                [ "$id", box parameter.templateId; "$name", box parameter.name; "$kind", box parameter.usageKind
                                  "$kinds", box (String.concat "|" parameter.usageKinds); "$inferred", box parameter.inferredType
                                  "$required", box (if parameter.required then 1 else 0); "$occurrences", box parameter.occurrences ]
                            inlineParameterCommand.ExecuteNonQuery() |> ignore
                        use inlineInvocationCommand = connection.CreateCommand()
                        inlineInvocationCommand.Transaction <- transaction
                        inlineInvocationCommand.CommandText <- "INSERT OR REPLACE INTO inline_invocations(invocation_id, caller_file, caller_line, template_id, enclosing_definition) VALUES ($id, $file, $line, $template, $enclosing)"
                        prepareCommandParameters inlineInvocationCommand
                            [ "$id", box ""; "$file", box ""; "$line", box 0; "$template", box ""; "$enclosing", box "" ]
                        for invocation in freshInlineGraph.invocations |> Seq.filter invocationAffected do
                            setPreparedCommandParameters inlineInvocationCommand
                                [ "$id", box invocation.invocationId; "$file", box invocation.callerFile; "$line", box invocation.callerLine
                                  "$template", box invocation.templateId; "$enclosing", box (invocation.enclosingDefinition |> Option.toObj) ]
                            inlineInvocationCommand.ExecuteNonQuery() |> ignore
                        use inlineArgumentCommand = connection.CreateCommand()
                        inlineArgumentCommand.Transaction <- transaction
                        inlineArgumentCommand.CommandText <- "INSERT OR REPLACE INTO inline_arguments(invocation_id, name, raw_value, resolved_value, value_kind) VALUES ($id, $name, $raw, $resolved, $kind)"
                        prepareCommandParameters inlineArgumentCommand
                            [ "$id", box ""; "$name", box ""; "$raw", box ""; "$resolved", box ""; "$kind", box "" ]
                        for argument in freshInlineGraph.arguments |> Seq.filter (fun argument -> affectedFreshInvocationIds.Contains argument.invocationId) do
                            setPreparedCommandParameters inlineArgumentCommand
                                [ "$id", box argument.invocationId; "$name", box argument.name; "$raw", box argument.rawValue
                                  "$resolved", box argument.resolvedValue; "$kind", box argument.valueKind ]
                            inlineArgumentCommand.ExecuteNonQuery() |> ignore
                        use inlineExpansionCommand = connection.CreateCommand()
                        inlineExpansionCommand.Transaction <- transaction
                        inlineExpansionCommand.CommandText <- "INSERT OR REPLACE INTO inline_expansions(invocation_id, expanded_symbol_id, entity_type, template_file, caller_file, template_line, generated_line, confidence) VALUES ($id, $symbol, $type, $templateFile, $callerFile, $templateLine, $generatedLine, $confidence)"
                        prepareCommandParameters inlineExpansionCommand
                            [ "$id", box ""; "$symbol", box ""; "$type", box ""; "$templateFile", box ""; "$callerFile", box ""; "$templateLine", box 0; "$generatedLine", box 0; "$confidence", box "" ]
                        for expansion in freshInlineGraph.expansions |> Seq.filter (fun expansion -> affectedFreshInvocationIds.Contains expansion.invocationId) do
                            setPreparedCommandParameters inlineExpansionCommand
                                [ "$id", box expansion.invocationId; "$symbol", box expansion.expandedSymbolId; "$type", box expansion.entityType
                                  "$templateFile", box expansion.templateFile; "$callerFile", box expansion.callerFile
                                  "$templateLine", box expansion.templateLine; "$generatedLine", box expansion.generatedLine; "$confidence", box expansion.confidence ]
                            inlineExpansionCommand.ExecuteNonQuery() |> ignore
                        use inlineGeneratedReferenceCommand = connection.CreateCommand()
                        inlineGeneratedReferenceCommand.Transaction <- transaction
                        inlineGeneratedReferenceCommand.CommandText <- "INSERT OR REPLACE INTO inline_generated_references(invocation_id, reference_kind, expanded_value, template_file, caller_file, template_line, generated_line, confidence) VALUES ($id, $kind, $value, $templateFile, $callerFile, $templateLine, $generatedLine, $confidence)"
                        prepareCommandParameters inlineGeneratedReferenceCommand
                            [ "$id", box ""; "$kind", box ""; "$value", box ""; "$templateFile", box ""; "$callerFile", box ""; "$templateLine", box 0; "$generatedLine", box 0; "$confidence", box "" ]
                        for reference in freshInlineGraph.generatedReferences |> Seq.filter (fun reference -> affectedFreshInvocationIds.Contains reference.invocationId) do
                            setPreparedCommandParameters inlineGeneratedReferenceCommand
                                [ "$id", box reference.invocationId; "$kind", box reference.referenceKind; "$value", box reference.expandedValue
                                  "$templateFile", box reference.templateFile; "$callerFile", box reference.callerFile
                                  "$templateLine", box reference.templateLine; "$generatedLine", box reference.generatedLine; "$confidence", box reference.confidence ]
                            inlineGeneratedReferenceCommand.ExecuteNonQuery() |> ignore
                        use inlineProblemCommand = connection.CreateCommand()
                        inlineProblemCommand.Transaction <- transaction
                        inlineProblemCommand.CommandText <- "INSERT OR REPLACE INTO inline_problems(invocation_id, kind, message, line) VALUES ($id, $kind, $message, $line)"
                        prepareCommandParameters inlineProblemCommand
                            [ "$id", box ""; "$kind", box ""; "$message", box ""; "$line", box 0 ]
                        for problem in freshInlineGraph.problems |> Seq.filter (fun problem -> affectedFreshInvocationIds.Contains problem.invocationId) do
                            setPreparedCommandParameters inlineProblemCommand
                                [ "$id", box problem.invocationId; "$kind", box problem.kind; "$message", box problem.message; "$line", box problem.line ]
                            inlineProblemCommand.ExecuteNonQuery() |> ignore

                        let affectedDefinitionRows =
                            use command = connection.CreateCommand()
                            command.Transaction <- transaction
                            command.CommandText <- """
SELECT d.id, d.entity_type, d.symbol_id, d.overwrite_state, d.override_strategy, d.origin, d.logical_path
FROM definitions d
JOIN affected_symbols a
  ON d.entity_type = a.entity_type_key COLLATE NOCASE
 AND d.symbol_id = a.symbol_id_key COLLATE NOCASE
ORDER BY lower(d.entity_type), lower(d.symbol_id), d.id
"""
                            use reader = command.ExecuteReader()
                            let rows = ResizeArray<int64 * string * string * string * string option * string * string>()
                            while reader.Read() do
                                rows.Add(
                                    reader.GetInt64 0,
                                    reader.GetString 1,
                                    reader.GetString 2,
                                    reader.GetString 3,
                                    stringOrNone reader 4,
                                    reader.GetString 5,
                                    reader.GetString 6)
                            rows |> Seq.toList
                        use stackCommand = connection.CreateCommand()
                        stackCommand.Transaction <- transaction
                        stackCommand.CommandText <- "INSERT INTO definition_stacks(entity_type, symbol_id, resolution) VALUES ($type, $symbol, $resolution) RETURNING id"
                        use candidateCommand = connection.CreateCommand()
                        candidateCommand.Transaction <- transaction
                        candidateCommand.CommandText <- "INSERT INTO stack_candidates(stack_id, definition_id, is_active, candidate_order, origin, logical_path, override_strategy) VALUES ($stack, $definition, $active, $order, $origin, $logical, $strategy)"
                        use unresolvedCommand = connection.CreateCommand()
                        unresolvedCommand.Transaction <- transaction
                        unresolvedCommand.CommandText <- "INSERT INTO unresolved(kind, entity_type, symbol_id, resolution, message) VALUES ('definition_resolution', $type, $symbol, $resolution, 'The effective definition requires override-mode or ambiguity review.')"
                        for _, values in affectedDefinitionRows |> Seq.groupBy (fun (_, entityType, symbolId, _, _, _, _) -> entityType.ToLowerInvariant(), symbolId.ToLowerInvariant()) do
                            let items = values |> Seq.toList
                            if items.Length > 1 then
                                let originRank origin = if origin = "vanilla" then 0 elif origin = "workspace" then 2 else 1
                                let ordered = items |> List.sortBy (fun (_, _, _, _, _, origin, logical) -> originRank origin, normalizePath logical)
                                let _, entityType, symbolId, _, _, _, _ = ordered.Head
                                let active = ordered |> List.filter (fun (_, _, _, overwrite, _, _, _) -> overwrite <> "overwritten")
                                let strategy = ordered |> List.tryPick (fun (_, _, _, _, value, _, _) -> value |> Option.map (fun mode -> mode.ToUpperInvariant()))
                                let winnerId, resolution =
                                    if active.Length = 1 then let id, _, _, _, _, _, _ = active.Head in Some id, "cwtools_single_active"
                                    else
                                        match strategy with
                                        | Some "LIOS" -> let id, _, _, _, _, _, _ = ordered |> List.last in Some id, "last_in_only_served"
                                        | Some "FIOS" -> let id, _, _, _, _, _, _ = ordered.Head in Some id, "first_in_only_served"
                                        | Some "NO" -> let id, _, _, _, _, _, _ = ordered.Head in Some id, "no_individual_override"
                                        | Some "MERGE" -> None, "merged_definitions"
                                        | Some "DUPL" -> None, "duplicate_definitions"
                                        | _ -> None, "ambiguous"
                                setCommandParameters stackCommand [ "$type", box entityType; "$symbol", box symbolId; "$resolution", box resolution ]
                                let stackId = stackCommand.ExecuteScalar() :?> int64
                                for index, (definitionId, _, _, _, candidateStrategy, origin, logical) in ordered |> List.indexed do
                                    setCommandParameters candidateCommand
                                        [ "$stack", box stackId; "$definition", box definitionId
                                          "$active", box (if winnerId = Some definitionId then 1 else 0)
                                          "$order", box index
                                          "$origin", box origin
                                          "$logical", box logical
                                          "$strategy", box (candidateStrategy |> Option.toObj) ]
                                    candidateCommand.ExecuteNonQuery() |> ignore
                                if resolution = "ambiguous" then
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
                        let definitionCount = scalarCount "SELECT count(*) FROM definitions"
                        let workspaceDefinitionCount = scalarCount "SELECT count(*) FROM definitions WHERE origin = 'workspace'"
                        let dependencyDefinitionCount = scalarCount "SELECT count(*) FROM definitions WHERE origin = 'dependency'"
                        let vanillaDefinitionCount = scalarCount "SELECT count(*) FROM definitions WHERE origin = 'vanilla'"
                        let definitionStackCount = scalarCount "SELECT count(*) FROM definition_stacks"
                        let topologyFileCount = scalarCount "SELECT count(*) FROM files"
                        let topologyEdgeCount = scalarCount "SELECT count(*) FROM references_graph"
                        let eventNodeCount = scalarCount "SELECT count(*) FROM event_nodes"
                        let eventEdgeCount = scalarCount "SELECT count(*) FROM event_edges"
                        let eventLogicCount = scalarCount "SELECT count(*) FROM event_logic"
                        let inlineTemplateCount = scalarCount "SELECT count(*) FROM inline_templates"
                        let inlineInvocationCount = scalarCount "SELECT count(*) FROM inline_invocations"
                        let inlineExpansionCount = scalarCount "SELECT count(*) FROM inline_expansions"
                        let incrementalDurationMs = max 0 (int ((DateTimeOffset.UtcNow - incrementalStartedAt).TotalMilliseconds))
                        let databaseSizeBytes = try FileInfo(target).Length with _ -> 0L
                        use finalMetadataTransaction = connection.BeginTransaction()
                        let upsertFinalMetadata key value =
                            use command = connection.CreateCommand()
                            command.Transaction <- finalMetadataTransaction
                            command.CommandText <- "INSERT INTO metadata(key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
                            addParameter command "$key" (box key)
                            addParameter command "$value" (box value)
                            command.ExecuteNonQuery() |> ignore
                        upsertFinalMetadata "definition_count" (string definitionCount)
                        upsertFinalMetadata "topology_file_count" (string topologyFileCount)
                        upsertFinalMetadata "topology_edge_count" (string topologyEdgeCount)
                        upsertFinalMetadata "event_node_count" (string eventNodeCount)
                        upsertFinalMetadata "event_edge_count" (string eventEdgeCount)
                        upsertFinalMetadata "event_logic_count" (string eventLogicCount)
                        upsertFinalMetadata "inline_template_count" (string inlineTemplateCount)
                        upsertFinalMetadata "inline_invocation_count" (string inlineInvocationCount)
                        upsertFinalMetadata "inline_expansion_count" (string inlineExpansionCount)
                        upsertFinalMetadata "last_incremental_duration_ms" (string incrementalDurationMs)
                        upsertFinalMetadata "database_size_bytes" (string databaseSizeBytes)
                        finalMetadataTransaction.Commit()
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
                                  Some("schemaVersion", JsonValue.Number(decimal KnowledgeSchemaVersion))
                                  Some("capabilityVersions", capabilityVersionsJson)
                                  Some("capabilityStatus", capabilityStatusJson)
                                  Some("game", JsonValue.String activeGame)
                                  Some("generatedAtUnixMs", JsonValue.Number(decimal (generatedAt.ToUnixTimeMilliseconds())))
                                  Some("graphVersion", JsonValue.Number(decimal runtime.graphVersion))
                                  Some("completeExport", JsonValue.Boolean options.completeExport)
                                  Some("projectRoots", jsonStringArray projectRoots)
                                  Some("databasePath", JsonValue.String(normalizePath target))
                                  Some("generationMode", JsonValue.String "incremental")
                                  Some("domains", JsonValue.Array compactDomains)
                                  Some("baseline", jsonRecord
                                    [ Some("deterministicOrdering", JsonValue.Boolean true)
                                      Some("incrementalDurationMs", JsonValue.Number(decimal incrementalDurationMs))
                                      Some("changedFiles", JsonValue.Number(decimal changedFiles.Length))
                                      Some("databaseSizeBytes", JsonValue.Number(decimal databaseSizeBytes))
                                      Some("definitions", jsonRecord
                                        [ Some("total", JsonValue.Number(decimal definitionCount))
                                          Some("workspace", JsonValue.Number(decimal workspaceDefinitionCount))
                                          Some("dependency", JsonValue.Number(decimal dependencyDefinitionCount))
                                          Some("vanilla", JsonValue.Number(decimal vanillaDefinitionCount)) ])
                                      Some("inlineGraph", jsonRecord
                                        [ Some("templates", JsonValue.Number(decimal inlineTemplateCount))
                                          Some("invocations", JsonValue.Number(decimal inlineInvocationCount))
                                          Some("expansions", JsonValue.Number(decimal inlineExpansionCount)) ]) ])
                                  Some("coverage", jsonRecord
                                    [ Some("filesConsidered", JsonValue.Number(decimal topologyFileCount))
                                      Some("filesIndexed", JsonValue.Number(decimal topologyFileCount))
                                      Some("definitionsConsidered", JsonValue.Number(decimal definitionCount))
                                      Some("definitionsIndexed", JsonValue.Number(decimal definitionCount))
                                      Some("edgesConsidered", JsonValue.Number(decimal topologyEdgeCount))
                                      Some("edgesIndexed", JsonValue.Number(decimal topologyEdgeCount))
                                      Some("truncated", JsonValue.Boolean(oldTopologyTruncated || freshTopology.truncated))
                                      Some("staleReasons", jsonStringArray [ if runtime.status <> "ready" then yield "lsp_not_ready" ])
                                      Some("unsupportedConstructs", jsonStringArray [ if oldTopologyTruncated || freshTopology.truncated then yield "topology_export_limits_reached" ]) ])
                                  Some("counts", jsonRecord
                                    [ Some("definitions", JsonValue.Number(decimal definitionCount))
                                      Some("availableDefinitions", JsonValue.Number(decimal definitionCount))
                                      Some("workspaceDefinitions", JsonValue.Number(decimal workspaceDefinitionCount))
                                      Some("dependencyDefinitions", JsonValue.Number(decimal dependencyDefinitionCount))
                                      Some("vanillaDefinitions", JsonValue.Number(decimal vanillaDefinitionCount))
                                      Some("definitionStacks", JsonValue.Number(decimal definitionStackCount))
                                      Some("topologyFiles", JsonValue.Number(decimal topologyFileCount))
                                      Some("topologyEdges", JsonValue.Number(decimal topologyEdgeCount))
                                      Some("eventNodes", JsonValue.Number(decimal eventNodeCount))
                                      Some("eventEdges", JsonValue.Number(decimal eventEdgeCount))
                                      Some("eventLogic", JsonValue.Number(decimal eventLogicCount)) ])
                                  Some("freshness", jsonRecord
                                    [ Some("validationInProgress", JsonValue.Boolean runtime.validationInProgress)
                                      Some("loadingInProgress", JsonValue.Boolean runtime.loadingInProgress)
                                      Some("pendingGlobalKinds", jsonStringArray runtime.pendingGlobalKinds)
                                      Some("lastGlobalRefreshAtUnixMs", JsonValue.Number(decimal runtime.lastGlobalRefreshAtUnixMs)) ])
                                  Some("warnings", jsonStringArray warnings) ])

let exportProjectKnowledgeCancellable shouldCancel (activeGame: string) (projectRoots: string list) (rawOptions: ExportOptions) (runtime: RuntimeMetadata) (game: IGame<'T>) =
    let run () =
        match tryIncrementalProjectKnowledgeExport shouldCancel activeGame projectRoots rawOptions runtime game with
        | Some result -> result
        | None -> exportProjectKnowledgeRebuild shouldCancel activeGame projectRoots rawOptions runtime game
    match rawOptions.databasePath with
    | Some databasePath ->
        let key = Path.GetFullPath databasePath
        let gate = databaseWriteGates.GetOrAdd(key, fun _ -> obj())
        lock gate run
    | None -> run ()

let exportProjectKnowledge activeGame projectRoots rawOptions runtime game =
    exportProjectKnowledgeCancellable (fun () -> false) activeGame projectRoots rawOptions runtime game
