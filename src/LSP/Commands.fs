namespace LSP

type CommandMetadata = {
    Name: string
    IsReadOnly: bool
}

module Commands =
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
            readCmd "cwtools.exportTypes"
            readCmd "getFileTypes"
            readCmd "typeGraphInfo"
            readCmd "getDataForFile"
            readCmd "getTypesForFile"

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
