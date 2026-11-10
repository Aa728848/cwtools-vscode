namespace LSP

open System
open System.IO

type CommandMetadata = {
    Name: string
    IsReadOnly: bool
}

module Commands =
    /// Protocol version of the `cwtools.ai.getHostCapabilities` response. A client
    /// that does not recognise this number must not drive the server.
    [<Literal>]
    let HostCapabilitiesProtocolVersion = 1

    /// Version reported by the capability handshake. The nearest release/package.json
    /// is authoritative in both development output and the VSIX. Assembly metadata is
    /// only a fallback for hosts that do not ship the release manifest.
    let serverVersion: string =
        let target = typeof<CommandMetadata>.Assembly
        let fallback =
            let informational =
                target.GetCustomAttributes(typeof<System.Reflection.AssemblyInformationalVersionAttribute>, false)
                |> Array.tryHead
                |> Option.map (fun attribute ->
                    (attribute :?> System.Reflection.AssemblyInformationalVersionAttribute).InformationalVersion)
            match informational with
            | Some (value: string) when not (String.IsNullOrWhiteSpace value) ->
                match value.IndexOf('+') with
                | -1 -> value
                | index -> value.Substring(0, index)
            | _ ->
                let version = target.GetName().Version
                if isNull (box version) then "0.0.0-unknown" else version.ToString()
        try
            let directory = Path.GetDirectoryName(target.Location)
            let candidates = [
                for depth in 1..6 do
                    let root = Path.GetFullPath(Path.Combine(directory, String.replicate depth (".." + string Path.DirectorySeparatorChar)))
                    yield Path.Combine(root, "release", "package.json")
                    yield Path.Combine(root, "package.json")
            ]
            match candidates |> Seq.tryFind File.Exists with
            | Some path ->
                use document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(path))
                let value = document.RootElement.GetProperty("version").GetString()
                if String.IsNullOrWhiteSpace value then fallback else value
            | None -> fallback
        with _ ->
            fallback

    let private readCmd name = { Name = name; IsReadOnly = true }
    let private writeCmd name = { Name = name; IsReadOnly = false }

    let allCommands: CommandMetadata list =
        [
            // Legacy / Server management commands
            writeCmd "pretriggerThisFile"
            writeCmd "pretriggerAllFiles"
            writeCmd "genlocfile"
            writeCmd "genlocall"
            writeCmd "debugrules"
            writeCmd "outputerrors"
            writeCmd "reloadrulesconfig"
            writeCmd "cacheVanilla"
            writeCmd "listAllFiles"
            writeCmd "listAllLocFiles"
            writeCmd "gettech"
            writeCmd "getGraphData"
            writeCmd "exportTypes"

            // Query / file inspection commands
            readCmd "cwtools.findTypeReferences"
            readCmd "getFileTypes"
            readCmd "cwtools.localisation.generateAura"

            // AI Read-only commands
            readCmd "cwtools.ai.getScopeAtPosition"
            readCmd "cwtools.ai.getCompletionContext"
            readCmd "cwtools.ai.queryTypes"
            readCmd "cwtools.ai.queryDefinition"
            readCmd "cwtools.ai.queryDefinitionByName"
            readCmd "cwtools.ai.exploreProject"
            readCmd "cwtools.ai.exploreInlineGraph"
            readCmd "cwtools.ai.analyzePdxFlow"
            readCmd "cwtools.ai.queryLocalisationAudit"
            readCmd "cwtools.ai.compareDefinitionWithVanilla"
            readCmd "cwtools.ai.queryProjectKnowledgeDb"
            readCmd "cwtools.ai.getSemanticCatalog"
            readCmd "cwtools.ai.validateOverlay"
            readCmd "cwtools.ai.queryScriptedEffects"
            readCmd "cwtools.ai.queryScriptedTriggers"
            readCmd "cwtools.ai.queryEnums"
            readCmd "cwtools.ai.getEntityInfo"
            readCmd "cwtools.ai.queryStaticModifiers"
            readCmd "cwtools.ai.queryVariables"
            readCmd "cwtools.ai.queryOverrideModes"
            readCmd "cwtools.ai.getDiagnosticsFresh"
            readCmd "cwtools.ai.getAllDiagnostics"
            readCmd "cwtools.ai.waitDiagnosticsFresh"
            readCmd "cwtools.ai.getValidationStatus"
            readCmd "cwtools.ai.revalidateFiles"
            readCmd "cwtools.ai.parseFragment"
            // Internal handshake: answered before the game model loads and never
            // exposed as a model-facing tool.
            readCmd "cwtools.ai.getHostCapabilities"

            // AI revalidation commands. revalidateAll drives the invalidation
            // tracker and the deferred drain, so it is a write command even though
            // it rewrites no file.
            writeCmd "cwtools.ai.revalidateAll"

            // AI Shader commands
            readCmd "cwtools.ai.shader.symbols"
            readCmd "cwtools.ai.shader.compileUnit"
            readCmd "cwtools.ai.shader.variants"
            readCmd "cwtools.ai.shader.callers"
            readCmd "cwtools.ai.shader.reachability"
            readCmd "cwtools.ai.shader.validate"
            readCmd "cwtools.ai.shader.preflightEdit"
            readCmd "cwtools.ai.shader.compareVanilla"

            // Export project knowledge (default write, incremental may be read)
            writeCmd "cwtools.ai.exportProjectKnowledge"
        ]

    let private readOnlySet =
        allCommands
        |> List.choose (fun c -> if c.IsReadOnly then Some c.Name else None)
        |> Set.ofList

    let isReadOnly (name: string) : bool =
        readOnlySet.Contains(name)

    let allCommandNames: string list =
        allCommands |> List.map (fun c -> c.Name)
