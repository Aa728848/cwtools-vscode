#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/Microsoft.Data.Sqlite.dll"
#r "../../artifacts/bin/Main/debug/SQLitePCLRaw.core.dll"
#r "../../artifacts/bin/Main/debug/SQLitePCLRaw.batteries_v2.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.DesignTime.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.dll"

#load "../TestHelpers.fsx"

open System
open System.IO
open System.Text.RegularExpressions
open FSharp.Data
open Main.ProjectKnowledge
open TestHelpers

SQLitePCL.Batteries_V2.Init()

let assertTrue = assertTrueNamed
let assertFalse = assertFalseNamed

let executeCommand (connection: Microsoft.Data.Sqlite.SqliteConnection) (sql: string) (parameters: (string * obj) list) =
    use cmd = connection.CreateCommand()
    cmd.CommandText <- sql
    for key, value in parameters do
        cmd.Parameters.AddWithValue(key, if isNull value then box DBNull.Value else value) |> ignore
    cmd.ExecuteNonQuery() |> ignore

let insertMetadata (connection: Microsoft.Data.Sqlite.SqliteConnection) (entries: (string * string) seq) =
    for k, v in entries do
        executeCommand connection "INSERT INTO metadata(key, value) VALUES ($k, $v)" [ "$k", box k; "$v", box v ]

// Full and incremental export use separate transaction bodies. Guard the full
// writer against adding event-edge columns without binding their parameters.
let projectKnowledgeSource = File.ReadAllText(Path.Combine(__SOURCE_DIRECTORY__, "ProjectKnowledge.fs"))
let fullEventEdgeStart = projectKnowledgeSource.IndexOf("    use eventEdgeCommand = connection.CreateCommand()", StringComparison.Ordinal)
let fullEventEdgeEnd = projectKnowledgeSource.IndexOf("    use eventLogicCommand = connection.CreateCommand()", fullEventEdgeStart, StringComparison.Ordinal)
assertTrue "full event-edge writer block is present" (fullEventEdgeStart >= 0 && fullEventEdgeEnd > fullEventEdgeStart)
let fullEventEdgeWriter = projectKnowledgeSource.Substring(fullEventEdgeStart, fullEventEdgeEnd - fullEventEdgeStart)
for parameter in [ "$callOperator"; "$phase"; "$delay"; "$conditionPath"; "$scopeMap"; "$sourceScope"; "$targetScope" ] do
    assertTrue
        $"full event-edge writer binds {parameter} in SQL, preparation, and row values"
        (Regex.Matches(fullEventEdgeWriter, Regex.Escape(parameter)).Count >= 3)

assertTrue "complete export does not truncate event state facts"
    (projectKnowledgeSource.Contains("if options.completeExport then distinctState else distinctState |> Seq.truncate 30000", StringComparison.Ordinal))
assertTrue "full manifest eventLogic includes relation and state-access rows"
    (projectKnowledgeSource.Contains("eventGraph.logic.Length + eventGraph.stateAccesses.Length", StringComparison.Ordinal))

let outgoingSource, outgoingTarget = orientTypedReference "samplemod_legacy.38" "samplemod_legacy.39" true
let incomingSource, incomingTarget = orientTypedReference "container_event" "referenced_event" false
assertTrue "outgoing typed reference preserves source-to-target direction" (outgoingSource = "samplemod_legacy.38" && outgoingTarget = "samplemod_legacy.39")
assertTrue "incoming typed reference reverses target-to-source direction" (incomingSource = "referenced_event" && incomingTarget = "container_event")

let provenanceRootPath = Path.Combine(Path.GetTempPath(), "cwtools-origin-workspace")
let dependencyRootPath = Path.Combine(Path.GetTempPath(), "cwtools-origin-dependency")
let secondDependencyRootPath = Path.Combine(Path.GetTempPath(), "cwtools-origin-dependency-two")
CWTools.Games.PdxShaderProject.configureLoadOrderRoots
    [ "workspace", provenanceRootPath; "dependency", dependencyRootPath; "dependency-two", secondDependencyRootPath ]
assertTrue "workspace origin uses explicit load order roots"
    (resolveKnowledgeOrigin [ provenanceRootPath ] "workspace" (Path.Combine(provenanceRootPath, "events", "a.txt")) = "workspace")
assertTrue "dependency origin is not misclassified as vanilla"
    (resolveKnowledgeOrigin [ provenanceRootPath ] "dependency" (Path.Combine(dependencyRootPath, "events", "a.txt")) = "dependency")
assertTrue "vanilla scope remains authoritative"
    (resolveKnowledgeOrigin [ provenanceRootPath ] "vanilla" (Path.Combine(Path.GetTempPath(), "game", "events", "a.txt")) = "vanilla")
assertTrue "embedded files under the editable project remain workspace definitions"
    (resolveKnowledgeOriginWithRoots
        (Some provenanceRootPath)
        [ provenanceRootPath ]
        (Some(Path.Combine(Path.GetTempPath(), "game")))
        "embedded"
        (Path.Combine(provenanceRootPath, "gfx", "FX", "a.shader")) = "workspace")
assertTrue "embedded files under the configured game root are vanilla definitions"
    (resolveKnowledgeOriginWithRoots
        (Some provenanceRootPath)
        [ provenanceRootPath ]
        (Some(Path.Combine(Path.GetTempPath(), "game")))
        "embedded"
        (Path.Combine(Path.GetTempPath(), "game", "common", "buildings", "a.txt")) = "vanilla")
let vanillaOrder, vanillaRoot = resolveKnowledgeLoadOrder "vanilla" (Path.Combine(Path.GetTempPath(), "game", "events", "a.txt"))
let workspaceOrder, workspaceRootName = resolveKnowledgeLoadOrder "workspace" (Path.Combine(provenanceRootPath, "events", "a.txt"))
let dependencyOrder, dependencyRootName = resolveKnowledgeLoadOrder "dependency" (Path.Combine(dependencyRootPath, "events", "a.txt"))
let secondDependencyOrder, secondDependencyRootName = resolveKnowledgeLoadOrder "dependency" (Path.Combine(secondDependencyRootPath, "events", "a.txt"))
assertTrue "configured roots retain exact LSP load order"
    (vanillaOrder = 0 && workspaceOrder = 1 && dependencyOrder = 2 && secondDependencyOrder = 3)
assertTrue "configured roots retain dependency identity"
    (vanillaRoot = Some "vanilla" && workspaceRootName = Some "workspace" && dependencyRootName = Some "dependency" && secondDependencyRootName = Some "dependency-two")
CWTools.Games.PdxShaderProject.resetLoadOrderRoots ()

let root =
    Path.Combine(Path.GetTempPath(), "cwtools-project-knowledge-temp-cleanup-" + Guid.NewGuid().ToString("N"))

Directory.CreateDirectory(root) |> ignore

try
    let target = Path.Combine(root, "knowledge.sqlite")
    File.WriteAllText(target, "published")

    let abandonedLegacy = target + ".tmp-" + Guid.NewGuid().ToString("N")
    let recentLegacy = target + ".tmp-" + Guid.NewGuid().ToString("N")
    let abandonedOwned =
        target + ".tmp-" + Int32.MaxValue.ToString() + "-" + Guid.NewGuid().ToString("N")
    let liveOwned =
        target + ".tmp-" + Environment.ProcessId.ToString() + "-" + Guid.NewGuid().ToString("N")
    let unrelated = Path.Combine(root, "unrelated.tmp-" + Guid.NewGuid().ToString("N"))

    for file in [ abandonedLegacy; recentLegacy; abandonedOwned; liveOwned; unrelated ] do
        File.WriteAllText(file, "temporary")

    File.SetLastWriteTimeUtc(abandonedLegacy, DateTime.UtcNow.AddHours(-2.0))
    File.SetLastWriteTimeUtc(liveOwned, DateTime.UtcNow.AddHours(-2.0))

    cleanupStaleKnowledgeTemporaryFiles target

    assertFalse "old legacy temporary database is removed" (File.Exists abandonedLegacy)
    assertTrue "recent legacy temporary database is retained" (File.Exists recentLegacy)
    assertFalse "temporary database owned by a dead process is removed" (File.Exists abandonedOwned)
    assertTrue "temporary database owned by this live process is retained" (File.Exists liveOwned)
    assertTrue "published database is retained" (File.Exists target)
    assertTrue "unrelated temporary file is retained" (File.Exists unrelated)
finally
    Directory.Delete(root, true)

printfn "ProjectKnowledge temporary database cleanup regression tests passed"

let obsoleteRoot =
    Path.Combine(Path.GetTempPath(), "cwtools-project-knowledge-obsolete-" + Guid.NewGuid().ToString("N"))
Directory.CreateDirectory(obsoleteRoot) |> ignore
try
    let obsoleteDb = Path.Combine(obsoleteRoot, "knowledge.sqlite")
    do
        use connection = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=" + obsoleteDb)
        connection.Open()
        use command = connection.CreateCommand()
        command.CommandText <- "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO metadata(key, value) VALUES ('schema_version', '6');"
        command.ExecuteNonQuery() |> ignore
    let result =
        queryProjectKnowledgeDatabase
            { databasePath = obsoleteDb
              intent = None
              domains = []
              identifiers = []
              entityTypes = []
              includeProjectPatterns = true
              includeVanillaArchetypes = true
              includeTopology = true
              includeUnresolved = true
              includeEventGraph = true
              limit = 10 }
    assertFalse "obsolete schema is not queried" (result.Item("ok").AsBoolean())
    assertTrue "obsolete schema requires a rebuild" (result.Item("rebuildRequired").AsBoolean())
    assertTrue "obsolete schema reports the current version"
        (result.Item("foundSchemaVersion").AsInteger() = 6
         && result.Item("currentSchemaVersion").AsInteger() = KnowledgeSchemaVersion)
finally
    Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools()
    cleanupTempDir obsoleteRoot

printfn "ProjectKnowledge obsolete schema rejection regression tests passed"

// ─── coverage contract: query results must carry freshness/coverage ─────────
let coverageRoot =
    Path.Combine(Path.GetTempPath(), "cwtools-project-knowledge-coverage-" + Guid.NewGuid().ToString("N"))
Directory.CreateDirectory(coverageRoot) |> ignore
try
    let coverageDb = Path.Combine(coverageRoot, "knowledge.sqlite")
    do
        use connection = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=" + coverageDb)
        connection.Open()
        createKnowledgeSchema connection
        insertMetadata connection [
            "schema_version", "7"
            "status", "stale"
            "game", "stellaris"
            "generated_at", "2026-01-01T00:00:00.000Z"
            "graph_version", "4"
            "topology_truncated", "true"
            "definition_count", "10"
            "topology_file_count", "5"
            "topology_edge_count", "20"
        ]

    let options =
        { databasePath = coverageDb
          intent = Some "test"
          domains = []
          identifiers = []
          entityTypes = []
          includeProjectPatterns = true
          includeVanillaArchetypes = true
          includeTopology = true
          includeUnresolved = true
          includeEventGraph = true
          limit = 10 }
    let result = queryProjectKnowledgeDatabase options
    let coverage = result.Item("coverage")
    assertTrue "coverage.definitionsIndexed reports the indexed definition count"
        (coverage.Item("definitionsIndexed").AsInteger() = 10)
    assertTrue "coverage.filesIndexed reports the indexed file count"
        (coverage.Item("filesIndexed").AsInteger() = 5)
    assertTrue "coverage.truncated is carried from topology metadata"
        (coverage.Item("truncated").AsBoolean())
    let staleReasons = coverage.Item("staleReasons").AsArray()
    assertTrue "coverage.staleReasons flags a non-ready status"
        (staleReasons |> Seq.exists (fun value -> value.AsString() = "knowledge_stale"))
    assertTrue "query ok without schema-dependent tables"
        (result.Item("ok").AsBoolean())
finally
    Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools()
    cleanupTempDir coverageRoot

printfn "ProjectKnowledge coverage contract regression tests passed"

// ─── provenance contract: synthetic definitions are excluded from intent
// scans, exact identifier queries still surface them, and every real
// definition carries a nonzero source line ───────────────────────────────────
let provenanceRoot =
    Path.Combine(Path.GetTempPath(), "cwtools-project-knowledge-provenance-" + Guid.NewGuid().ToString("N"))
Directory.CreateDirectory(provenanceRoot) |> ignore
try
    let provenanceDb = Path.Combine(provenanceRoot, "knowledge.sqlite")
    do
        use connection = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=" + provenanceDb)
        connection.Open()
        createKnowledgeSchema connection
        insertMetadata connection [
            "schema_version", "7"
            "status", "ready"
            "game", "stellaris"
            "generated_at", "2026-01-01T00:00:00.000Z"
            "graph_version", "4"
            "topology_truncated", "false"
            "definition_count", "2"
            "topology_file_count", "1"
            "topology_edge_count", "0"
        ]
        let insert (sql: string) (values: (string * obj) list) = executeCommand connection sql values
        let definitionSql = "INSERT INTO definitions(symbol_id, entity_type, file_path, logical_path, line, end_line, origin, validate, overwrite_state, resource_scope, domain, override_path, override_strategy, provenance_kind, source_file, source_line, source_end_line, template_file, template_line, invocation_file, invocation_line, has_real_range, confidence) VALUES ($symbol, $type, $file, $logical, $line, $end, $origin, $validate, $overwrite, $scope, $domain, $overridePath, $overrideStrategy, $provenance, $sourceFile, $sourceLine, $sourceEndLine, $templateFile, $templateLine, $invocationFile, $invocationLine, $hasRealRange, $confidence)"
        insert definitionSql [ "$symbol", box "real_event.1"; "$type", box "event"; "$file", box "events/a.txt"; "$logical", box "events/a.txt"; "$line", box 5; "$end", box 9; "$origin", box "workspace"; "$validate", box 1; "$overwrite", box "none"; "$scope", box ""; "$domain", box "events"; "$overridePath", box ""; "$overrideStrategy", box ""; "$provenance", box "declared"; "$sourceFile", box "events/a.txt"; "$sourceLine", box 5; "$sourceEndLine", box 9; "$templateFile", box ""; "$templateLine", box 0; "$invocationFile", box ""; "$invocationLine", box 0; "$hasRealRange", box 1; "$confidence", box "high" ]
        insert definitionSql [ "$symbol", box "synthetic_mod_1"; "$type", box "modifier"; "$file", box "common/static_modifiers/generated.txt"; "$logical", box "common/static_modifiers/generated.txt"; "$line", box 0; "$end", box 0; "$origin", box "workspace"; "$validate", box 1; "$overwrite", box "none"; "$scope", box ""; "$domain", box "common"; "$overridePath", box ""; "$overrideStrategy", box ""; "$provenance", box "synthetic"; "$sourceFile", box ""; "$sourceLine", box 0; "$sourceEndLine", box 0; "$templateFile", box ""; "$templateLine", box 0; "$invocationFile", box ""; "$invocationLine", box 0; "$hasRealRange", box 0; "$confidence", box "low" ]
        insert "INSERT INTO definition_stacks(id, entity_type, symbol_id, resolution) VALUES (1, 'event', 'real_event.1', 'last_in_only_served')" []
        insert "INSERT INTO stack_candidates(stack_id, definition_id, is_active, candidate_order, origin, logical_path, override_strategy) VALUES (1, 1, 0, 0, 'vanilla', 'events/a.txt', 'LIOS')" []
        insert "INSERT INTO stack_candidates(stack_id, definition_id, is_active, candidate_order, origin, logical_path, override_strategy) VALUES (1, 2, 1, 1, 'workspace', 'events/!!a.txt', 'LIOS')" []

    let intentOptions =
        { databasePath = provenanceDb
          intent = Some "design a new event"
          domains = []
          identifiers = []
          entityTypes = []
          includeProjectPatterns = true
          includeVanillaArchetypes = true
          includeTopology = true
          includeUnresolved = true
          includeEventGraph = true
          limit = 20 }
    let intentResult = queryProjectKnowledgeDatabase intentOptions
    let intentEvidence = intentResult.Item("evidence").AsArray()
    assertTrue "intent queries exclude synthetic definitions"
        (intentEvidence |> Seq.forall (fun item -> item.Item("id").AsString() <> "synthetic_mod_1"))
    assertTrue "intent queries still return real declared definitions"
        (intentEvidence |> Seq.exists (fun item -> item.Item("id").AsString() = "real_event.1"))
    let realProvenance = intentEvidence |> Seq.find (fun item -> item.Item("id").AsString() = "real_event.1") |> fun item -> item.Item("provenance")
    assertTrue "returned definitions carry provenance kind"
        (realProvenance.Item("kind").AsString() = "declared")

    let stackResult = queryProjectKnowledgeDatabase { intentOptions with intent = None; identifiers = [ "real_event.1" ] }
    let stacks = stackResult.Item("definitionStacks").AsArray()
    assertTrue "definition stack query returns a structured stack object rather than a nested candidate array"
        (stacks.Length = 1
         && stacks.[0].Item("resolution").AsString() = "last_in_only_served"
         && stacks.[0].Item("ambiguous").AsBoolean() = false
         && stacks.[0].Item("winner").Item("candidateOrder").AsInteger() = 1
         && stacks.[0].Item("losers").AsArray().Length = 1)

    let exactOptions =
        { intentOptions with
            intent = None
            identifiers = [ "synthetic_mod_1" ] }
    let exactResult = queryProjectKnowledgeDatabase exactOptions
    let exactEvidence = exactResult.Item("evidence").AsArray()
    assertTrue "exact identifier queries can surface synthetic facts"
        (exactEvidence |> Seq.exists (fun item -> item.Item("id").AsString() = "synthetic_mod_1"))
finally
    Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools()
    cleanupTempDir provenanceRoot

printfn "ProjectKnowledge provenance regression tests passed"


// ─── state flow contract: variable/flag/target accesses surface with phase
// and condition path, and are queryable in both directions ───────────────────
let stateRoot =
    Path.Combine(Path.GetTempPath(), "cwtools-project-knowledge-state-" + Guid.NewGuid().ToString("N"))
Directory.CreateDirectory(stateRoot) |> ignore
try
    let stateDb = Path.Combine(stateRoot, "knowledge.sqlite")
    do
        use connection = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=" + stateDb)
        connection.Open()
        createKnowledgeSchema connection
        insertMetadata connection [
            "schema_version", "7"
            "status", "ready"
            "game", "stellaris"
            "generated_at", "2026-01-01T00:00:00.000Z"
            "graph_version", "6"
            "topology_truncated", "false"
        ]
        let insert (sql: string) (values: (string * obj) list) = executeCommand connection sql values
        insert "INSERT INTO event_logic(event_id, relation_type, subject, scope, phase, source_file, line, details) VALUES ($event, $type, $subject, $scope, $phase, $file, $line, $details)"
            [ "$event", box "samplemod.100"; "$type", box "variable_set"; "$subject", box "samplemod_counter"
              "$scope", box ""; "$phase", box "immediate"; "$file", box "events/samplemod.txt"; "$line", box 12
              "$details", box "if>AND" ]
        insert "INSERT INTO event_logic(event_id, relation_type, subject, scope, phase, source_file, line, details) VALUES ($event, $type, $subject, $scope, $phase, $file, $line, $details)"
            [ "$event", box "samplemod.101"; "$type", box "event_target_save"; "$subject", box "samplemod_target"
              "$scope", box ""; "$phase", box "option"; "$file", box "events/samplemod.txt"; "$line", box 30
              "$details", box "" ]
        insert "INSERT INTO event_edges(source_kind, source_id, target_event_id, edge_type, label, source_file, line, confidence, call_operator, phase, delay, condition_path, scope_map, source_scope, target_scope) VALUES ($kind, $source, $target, $type, $label, $file, $line, $confidence, $callOperator, $phase, $delay, $conditionPath, $scopeMap, $sourceScope, $targetScope)"
            [ "$kind", box "event"; "$source", box "samplemod.100"; "$target", box "samplemod.101"; "$type", box "typed_reference"
              "$label", box ""; "$file", box "events/samplemod.txt"; "$line", box 20; "$confidence", box "lsp"
              "$callOperator", box "country_event"; "$phase", box "option"; "$delay", box "days=30"
              "$conditionPath", box "option"; "$scopeMap", box "ROOT->FROM"; "$sourceScope", box "country"; "$targetScope", box "country" ]
        insert "INSERT INTO inline_templates VALUES ($id,$logical,$file,1,$hash)"
            [ "$id", box "samplemod/generate_event"; "$logical", box "common/inline_scripts/samplemod/generate_event.txt"; "$file", box "common/inline_scripts/samplemod/generate_event.txt"; "$hash", box "abc" ]
        insert "INSERT INTO inline_parameters VALUES ($template,$name,$kind,$kinds,$type,1,2)"
            [ "$template", box "samplemod/generate_event"; "$name", box "ID"; "$kind", box "generic_fragment"; "$kinds", box "generic_fragment|identifier"; "$type", box "incompatible" ]
        insert "INSERT INTO inline_parameters VALUES ($template,$name,$kind,$kinds,$type,1,2)"
            [ "$template", box "samplemod/generate_event"; "$name", box "JSON_KIND"; "$kind", box "identifier"; "$kinds", box "[\"identifier\"]"; "$type", box "identifier" ]
        insert "INSERT INTO inline_invocations VALUES ($id,$file,42,$template,$enclosing)"
            [ "$id", box "inv-samplemod-42"; "$file", box "events/samplemod_caller.txt"; "$template", box "samplemod/generate_event"; "$enclosing", box "samplemod.1" ]
        insert "INSERT INTO inline_arguments VALUES ($inv,$name,$raw,$resolved,$kind)"
            [ "$inv", box "inv-samplemod-42"; "$name", box "ID"; "$raw", box "samplemod.42"; "$resolved", box "samplemod.42"; "$kind", box "identifier" ]
        insert "INSERT INTO inline_expansions VALUES ($inv,$symbol,$type,$templateFile,$caller,3,42,$confidence)"
            [ "$inv", box "inv-samplemod-42"; "$symbol", box "samplemod.42"; "$type", box "event"; "$templateFile", box "common/inline_scripts/samplemod/generate_event.txt"; "$caller", box "events/samplemod_caller.txt"; "$confidence", box "expanded" ]

    let stateOptions =
        { databasePath = stateDb
          intent = None
          domains = []
          identifiers = []
          entityTypes = []
          includeProjectPatterns = true
          includeVanillaArchetypes = true
          includeTopology = true
          includeUnresolved = true
          includeEventGraph = true
          limit = 30 }
    let stateResult = queryProjectKnowledgeDatabase stateOptions
    let stateLogic = stateResult.Item("eventGraph").Item("logic").AsArray()
    assertTrue "variable accesses surface with relation type and phase"
        (stateLogic |> Seq.exists (fun item ->
            item.Item("relationType").AsString() = "variable_set"
            && item.Item("subject").AsString() = "samplemod_counter"
            && item.Item("phase").AsString() = "immediate"
            && item.Item("details").AsString() = "if>AND"))
    assertTrue "event target saves surface as state facts"
        (stateLogic |> Seq.exists (fun item ->
            item.Item("relationType").AsString() = "event_target_save"
            && item.Item("subject").AsString() = "samplemod_target"
            && item.Item("phase").AsString() = "option"))
    let stateEdges = stateResult.Item("eventGraph").Item("edges").AsArray()
    assertTrue "event edges carry call operator, delay and scope map"
        (stateEdges |> Seq.exists (fun item ->
            item.Item("callOperator").AsString() = "country_event"
            && item.Item("delay").AsString() = "days=30"
            && item.Item("scopeMap").AsString() = "ROOT->FROM"))
    let inlineResult = queryProjectKnowledgeDatabase { stateOptions with identifiers = [ "samplemod.42" ] }
    let inlineGraph = inlineResult.Item("inlineGraph")
    assertTrue "knowledge query seeds inline graph by expanded symbol id"
        (inlineGraph.Item("expansions").AsArray() |> Seq.exists (fun item -> item.Item("expandedSymbolId").AsString() = "samplemod.42"))
    assertTrue "knowledge query returns the caller and arguments for an expanded id"
        (inlineGraph.Item("invocations").AsArray().Length = 1 && inlineGraph.Item("arguments").AsArray().Length = 1)
    let inlineParameters = inlineGraph.Item("parameters").AsArray()
    let usageKindsFor name =
        inlineParameters
        |> Array.find (fun item -> item.Item("name").AsString() = name)
        |> fun item -> item.Item("usageKinds").AsArray() |> Array.map _.AsString()
    assertTrue "knowledge query reads exported pipe-delimited inline usage kinds"
        (usageKindsFor "ID" = [| "generic_fragment"; "identifier" |])
    assertTrue "knowledge query remains compatible with JSON inline usage kinds"
        (usageKindsFor "JSON_KIND" = [| "identifier" |])
    // Synthetic bounded-query performance monitoring. Measured p95 is emitted
    // so regressions remain visible in logs without risking CI timing flakes.
    queryProjectKnowledgeDatabase stateOptions |> ignore
    let queryDurations =
        [ for _ in 1..40 do
            let timer = Diagnostics.Stopwatch.StartNew()
            queryProjectKnowledgeDatabase stateOptions |> ignore
            timer.Stop()
            yield timer.Elapsed.TotalMilliseconds ]
        |> List.sort
    let p95Index = min (queryDurations.Length - 1) (int (Math.Ceiling(float queryDurations.Length * 0.95)) - 1)
    let p95Ms = queryDurations.[p95Index]
    printfn "ProjectKnowledge synthetic query p95=%.2fms budget=250ms" p95Ms
    if p95Ms >= 250.0 then
        printfn "WARNING: synthetic project knowledge query p95 exceeded budget (%.2fms >= 250ms)" p95Ms
finally
    Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools()
    cleanupTempDir stateRoot

printfn "ProjectKnowledge state flow regression tests passed"
