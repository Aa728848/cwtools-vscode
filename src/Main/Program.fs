module Main.Program

open LSP
open LSP.Types
open System
open System.IO
open CWTools.Parser
open CWTools.Common
open CWTools.Games
open FParsec
open System.Threading.Tasks
open System.Text
open System.Reflection
open System.Runtime.InteropServices
open FSharp.Data
open CWTools.Rules
open CWTools.Utilities.Position
open Languages
open Main.Serialize
open Main.Git
open System.Diagnostics
open Main.Lang.GameLoader
open Main.Lang.LanguageServerFeatures
open Main.Completion
open CWTools.Utilities.Utils
open LSP.LanguageServer   // brings gameStateLock into scope

let private TODO () = raise (Exception "TODO")

[<assembly: AssemblyDescription("CWTools language server for PDXScript")>]
do ()

// client.LogMessage { ``type`` = MessageType.Error; message = "error"}
// client.LogMessage { ``type`` = MessageType.Warning; message = "warning"}
// client.LogMessage { ``type`` = MessageType.Info; message = "info"}
// client.LogMessage { ``type`` = MessageType.Log; message = "log"}
let mutable diagnosticLogging = false

let setupLogger (client: ILanguageClient) =
    let logInfo =
        (fun m ->
            client.LogMessage
                { ``type`` = MessageType.Info
                  message = m })

    let logWarning =
        (fun m ->
            client.LogMessage
                { ``type`` = MessageType.Warning
                  message = m })

    let logError =
        (fun m ->
            client.LogMessage
                { ``type`` = MessageType.Error
                  message = m })

    let logDiag =
        (fun m ->
            if diagnosticLogging then
                client.LogMessage
                    { ``type`` = MessageType.Log
                      message = sprintf "[Diag - %s] %s" (System.DateTime.Now.ToString("HH:mm:ss")) m })

    CWTools.Utilities.Utils.logInfo <- logInfo
    CWTools.Utilities.Utils.logWarning <- logWarning
    CWTools.Utilities.Utils.logError <- logError
    CWTools.Utilities.Utils.logDiag <- logDiag

type LintRequestMsg =
    | UpdateRequest of VersionedTextDocumentIdentifier * bool
    | WorkComplete of DateTime

type Server(client: ILanguageClient) =
    do setupLogger client
    let docs = DocumentStore()

    let notFound (doc: Uri) () : 'Any =
        raise (Exception $"%s{doc.ToString()} does not exist")

    let mutable activeGame = STL
    let mutable isVanillaFolder = false
    let mutable gameObj: option<IGame> = None
    let mutable stlGameObj: option<IGame<STLComputedData>> = None
    let mutable hoi4GameObj: option<IGame<HOI4ComputedData>> = None
    let mutable eu4GameObj: option<IGame<EU4ComputedData>> = None
    let mutable ck2GameObj: option<IGame<CK2ComputedData>> = None
    let mutable irGameObj: option<IGame<IRComputedData>> = None
    let mutable vic2GameObj: option<IGame<VIC2ComputedData>> = None
    let mutable ck3GameObj: option<IGame<CK3ComputedData>> = None
    let mutable vic3GameObj: option<IGame<VIC3ComputedData>> = None
    let mutable eu5GameObj: option<IGame<EU5ComputedData>> = None
    let mutable customGameObj: option<IGame<JominiComputedData>> = None

    let mutable languages: Lang array = [||]
    let mutable rootUri: Uri option = None
    let mutable workspaceFolders: WorkspaceFolder list = []
    let mutable cachePath: string option = None
    let mutable stlVanillaPath: string option = None
    let mutable hoi4VanillaPath: string option = None
    let mutable eu4VanillaPath: string option = None
    let mutable ck2VanillaPath: string option = None
    let mutable irVanillaPath: string option = None
    let mutable vic2VanillaPath: string option = None
    let mutable ck3VanillaPath: string option = None
    let mutable vic3VanillaPath: string option = None
    let mutable eu5VanillaPath: string option = None

    // Getter function for stlVanillaPath
    let getSTLVanillaPath() = stlVanillaPath

    // Fallback paths for scripted variables hover (user configurable)

    let mutable remoteRepoPath: string option = None

    let mutable rulesChannel: string = "stable"
    let mutable manualRulesFolder: string option = None
    let mutable useManualRules: bool = false
    let mutable validateVanilla: bool = false
    let mutable experimental: bool = false
    let mutable debugMode: bool = false
    let mutable maxFileSize: int = 2
    let mutable generatedStrings: string = ":0 \"REPLACE_ME\""
    let mutable clientSupportsInsertReplaceEdit: bool = false
    let mutable showInlineText: bool = false

    let mutable ignoreCodes: string array = [||]
    let mutable ignoreFiles: string array = [||]
    let mutable dontLoadPatterns: string array = [||]
    /// key: FileName (使用 Dictionary 替代不可变 Map 以减少 GC 压力)
    let locCache = System.Collections.Generic.Dictionary<string, CWError list>()

    /// SemanticTokens cache: filePath → (contentHash, tokenData)
    /// Avoids full AST re-traversal when file content hasn't changed.
    let semanticTokensCache = System.Collections.Generic.Dictionary<string, int * int list>()

    /// CodeLens cache: filePath → (contentHash, lenses)
    let codeLensCache = System.Collections.Generic.Dictionary<string, int * CodeLens list>()

    /// Content hash using .NET's built-in string hash (catches single-char edits that
    /// don't change line count, unlike the old length ^^^ lineCount approach).
    let contentHash (text: string) =
        text.GetHashCode()

    let mutable lastFocusedFile: string option = None

    let mutable currentlyRefreshingFiles: bool = false

    let (|TrySuccess|TryFailure|) tryResult =
        match tryResult with
        | true, value -> TrySuccess value
        | _ -> TryFailure

    let sevToDiagSev =
        function
        | Severity.Error -> DiagnosticSeverity.Error
        | Severity.Warning -> DiagnosticSeverity.Warning
        | Severity.Information -> DiagnosticSeverity.Information
        | Severity.Hint -> DiagnosticSeverity.Hint
        | _ -> DiagnosticSeverity.Information

    let parserErrorToDiagnostics e =
        let code, sev, file, error, (position: range), length, related = e

        let startC, endC =
            match length with
            | 0 -> 0, (int position.StartColumn)
            | _ -> (int position.StartColumn), (int position.StartColumn) + length

        let startLine = (int position.StartLine) - 1
        let startLine = max startLine 0

        let createUri (f: string) =
            (match Uri.TryCreate(f, UriKind.Absolute) with
             | TrySuccess value -> value
             | TryFailure ->
                 logWarning f
                 Uri "/")

        let result =
            { range =
                { start = { line = startLine; character = startC }
                  ``end`` = { line = startLine; character = endC } }
              severity = Some(sevToDiagSev sev)
              code = Some code
              source = Some code
              message = error
              relatedInformation =
                related
                |> Option.map (
                    List.map (fun rel ->
                        { DiagnosticRelatedInformation.location =
                            { uri = createUri rel.location.FileName
                              range = convRangeToLSPRange rel.location }
                          message = rel.message })
                )
                |> Option.defaultValue [] }

        (file, result)

    let sendDiagnostics s =
        let diagnosticFilter (f: string, d) =
            match (f, d) with
            | _, { Diagnostic.code = Some code } when Array.contains code ignoreCodes -> false
            | f, _ when Array.contains (Path.GetFileName f) ignoreFiles -> false
            | _, _ -> true

        s
        |> List.groupBy fst
        |> List.map (
            (fun (f, rs) -> f, rs |> List.filter diagnosticFilter)
            >> (fun (f, rs) ->
                try
                    { uri =
                        (match Uri.TryCreate(f, UriKind.Absolute) with
                         | TrySuccess value -> value
                         | TryFailure ->
                             logWarning f
                             Uri "/")
                      diagnostics = List.map snd rs }
                with e ->
                    failwith $"%A{e} %A{rs}")
        )
        |> List.iter client.PublishDiagnostics

    let mutable delayedLocUpdate = false

    let lint (doc: Uri) (shallowAnalyze: bool) (forceDisk: bool) : Async<unit> =
        async {
            let name = getPathFromDoc doc
            // Invalidate semantic/codelens cache for THIS file only (not globally)
            semanticTokensCache.Remove(doc.LocalPath) |> ignore
            codeLensCache.Remove(doc.LocalPath) |> ignore

            if name.EndsWith(".yml") then
                delayedLocUpdate <- true
            else
                ()

            // 优化：只获取一次文件文本，避免重复 GetText 调用
            let filetext =
                if forceDisk then None
                else docs.GetText(FileInfo(doc.LocalPath))

            let getRange (start: Position) (endp: Position) =
                mkRange
                    start.StreamName
                    (mkPos (int start.Line) (int start.Column))
                    (mkPos (int endp.Line) (int endp.Column))

            let parserErrors =
                match filetext with
                | None -> []
                | Some t ->
                    let parsed = CKParser.parseString t name

                    match name, parsed with
                    | x, _ when x.EndsWith(".yml") -> []
                    | _, Success _ -> []
                    | _, Failure(msg, p, _) ->
                        [ ("CW001", Severity.Error, name, msg, (getRange p.Position p.Position), 0, None) ]

            let locErrors =
                match locCache.TryGetValue(doc.LocalPath) with
                | true, errors -> errors
                | false, _ -> []
                |> List.map (fun e ->
                    (e.code, e.severity, e.range.FileName, e.message, e.range, e.keyLength, e.relatedErrors))
            // logDiag (sprintf "lint le %A" (locCache.TryFind (doc.LocalPath) |> Option.defaultValue []))
            
            // 优化：本地化文件（.yml）不需要调用 game.UpdateFile 进行语法验证
            // 因为本地化错误已经通过 locCache 获取，避免重复处理和内存开销
            let errors =
                if name.EndsWith(".yml") then
                    // 本地化文件只使用 locCache 的错误，跳过 game.UpdateFile
                    parserErrors @ locErrors
                else
                    // 普通文件需要进行完整的语法验证
                    // UpdateFile 会修改 game 内部的 AST/errorCache，必须持写锁
                    parserErrors
                    @ locErrors
                    @ match gameObj with
                      | None -> []
                      | Some game ->
                          gameStateLock.EnterWriteLock()
                          let results =
                              try game.UpdateFile shallowAnalyze name filetext
                              finally gameStateLock.ExitWriteLock()
                          // logDiag (sprintf "lint uf %A" results)
                          results
                          |> List.map (fun e ->
                              (e.code, e.severity, e.range.FileName, e.message, e.range, e.keyLength, e.relatedErrors))

            match errors with
            | [] -> client.PublishDiagnostics { uri = doc; diagnostics = [] }
            | x -> x |> List.map parserErrorToDiagnostics |> sendDiagnostics
        }

    let mutable delayTime = TimeSpan(0, 0, 5)

    let delayedAnalyze () =
        match gameObj with
        | Some game ->
            let timestamp = Stopwatch.GetTimestamp()
            // RefreshCaches rewrites infoService/ruleValidationService/completionService — exclusive write lock
            gameStateLock.EnterWriteLock()
            try
                game.RefreshCaches()

                if delayedLocUpdate then
                    logDiag "delayedLocUpdate true"
                    game.RefreshLocalisationCaches()
                    delayedLocUpdate <- false

                    // 使用 Dictionary: 清空后重新填充
                    locCache.Clear()
                    for fileName, errors in game.LocalisationErrors(true, true) |> List.groupBy _.range.FileName do
                        locCache.[fileName] <- errors
                else
                    logDiag "delayedLocUpdate false"

                    locCache.Clear()
                    for fileName, errors in game.LocalisationErrors(false, true) |> List.groupBy _.range.FileName do
                        locCache.[fileName] <- errors

                // Effect/trigger sets may have changed — invalidate all semantic caches.
                // Unlike the old Clear() which caused VSCode to lose all highlighting,
                // we now keep stale entries: SemanticTokensFull will return cached data
                // when the entity is not yet rebuilt, then VSCode re-requests once the
                // AST is ready. We clear codeLens because it's cheaper to recompute.
                semanticTokensCache.Clear()
                codeLensCache.Clear()
            finally
                gameStateLock.ExitWriteLock()

            let time = Stopwatch.GetElapsedTime(timestamp)

            delayTime <-
                TimeSpan(Math.Min(TimeSpan(0, 0, 30).Ticks, Math.Max(TimeSpan(0, 0, 3).Ticks, 2L * time.Ticks)))
            
            // 定期清理不存在文件的缓存，防止内存泄漏
            try
                let existingFiles = 
                    docs.OpenFiles() 
                    |> List.map (fun f -> f.FullName) 
                    |> Set.ofList
                game.CleanupCache existingFiles
            with e ->
                logDiag $"CleanupCache failed: {e.Message}"
            
            // L6/L3 Fix: Use non-blocking Gen2 GC only after a full refresh to
            // reclaim large rule data; avoid frequent mid-stream GC in hot path.
            if locCache.Count > 500 then
                GC.Collect(2, System.GCCollectionMode.Optimized, false, false)
        | None -> ()


    let lintAgent =
        MailboxProcessor.Start(fun agent ->
            let mutable nextAnalyseTime = DateTime.Now

            let analyzeTask uri force =
                new Task(fun () ->
                    let mutable nextTime = nextAnalyseTime

                    try
                        try
                            let shallowAnalyse = DateTime.Now < nextTime
                            logDiag $"lint force: %b{force}, shallow: %b{shallowAnalyse}"
                            lint uri (shallowAnalyse && (not force)) false |> Async.RunSynchronously

                            if not shallowAnalyse then
                                delayedAnalyze ()
                                logDiag "lint after delayed"
                                // Somehow get updated localisation errors after loccache is updated
                                lint uri true false |> Async.RunSynchronously
                                nextTime <- DateTime.Now.Add(delayTime)
                            else
                                ()
                        with e ->
                            logError $"uri %A{uri.LocalPath} \n exception %A{e}"
                    finally
                        agent.Post(WorkComplete(nextTime)))

            let analyze (file: VersionedTextDocumentIdentifier) force =
                //eprintfn "Analyze %s" (file.uri.ToString())
                let task = analyzeTask file.uri force
                task.Start()

            let rec loop (inprogress: bool) (state: Map<string, VersionedTextDocumentIdentifier * bool>) =
                async {
                    let! msg = agent.Receive()

                    if state.Count > 0 then
                        logDiag $"queue length: %i{state.Count}"

                    match msg, inprogress with
                    | UpdateRequest(ur, force), false ->
                        analyze ur force
                        return! loop true state
                    | UpdateRequest(ur, force), true ->
                        if Map.containsKey ur.uri.LocalPath state then
                            if
                                (Map.find ur.uri.LocalPath state)
                                |> (fun ({ VersionedTextDocumentIdentifier.version = v }, _) -> v < ur.version)
                            then
                                return! loop inprogress (state |> Map.add ur.uri.LocalPath (ur, force))
                            else
                                return! loop inprogress state
                        else
                            return! loop inprogress (state |> Map.add ur.uri.LocalPath (ur, force))
                    | WorkComplete time, _ ->
                        nextAnalyseTime <- time

                        if Map.isEmpty state then
                            return! loop false state
                        else
                            let key, (next, force) =
                                state
                                |> Map.pick (fun k v ->
                                    (k, v)
                                    |> function
                                        | k, v -> Some(k, v))

                            let newstate = state |> Map.remove key
                            analyze next force
                            return! loop true newstate
                }

            loop false Map.empty)

    /// Debounce agent for DidChangeTextDocument → lintAgent.
    /// Waits 1.5 seconds of inactivity before forwarding the lint request.
    /// This prevents write-lock contention during rapid typing.
    let lintDebounceAgent =
        MailboxProcessor.Start(fun agent ->
            let rec loop (pending: (VersionedTextDocumentIdentifier * bool) option) =
                async {
                    // Wait up to 1500ms for a new message; if none, fire the pending lint
                    let! msgOpt = agent.TryReceive(1500)
                    match msgOpt with
                    | Some (UpdateRequest(ur, force)) ->
                        // New edit arrived — reset the debounce timer
                        return! loop (Some (ur, force))
                    | Some (WorkComplete _) ->
                        // Ignore WorkComplete messages in debounce agent
                        return! loop pending
                    | None ->
                        // Timeout: 1.5s of inactivity — forward to lintAgent
                        match pending with
                        | Some (ur, force) ->
                            lintAgent.Post(UpdateRequest(ur, force))
                            return! loop None
                        | None ->
                            return! loop None
                }
            loop None)

    let setupRulesCaches () =
        match cachePath, remoteRepoPath, useManualRules with
        | Some cp, Some rp, false ->
            let stable = rulesChannel <> "latest"

            client.CustomNotification(
                "loadingBar",
                JsonValue.Record
                    [| "value", JsonValue.String("Updating validation rules...")
                       "enable", JsonValue.Boolean(true) |]
            )

            match initOrUpdateRules rp cp stable true with
            | true, Some date ->
                let text = $"Validation rules for {activeGame} have been updated to {date}."
                logInfo text
            | _ -> ()

            client.CustomNotification(
                "loadingBar",
                JsonValue.Record [| "value", JsonValue.String(""); "enable", JsonValue.Boolean(false) |]
            )
        | _ -> ()

    let checkOrSetGameCache (forceCreate: bool) =
        match (cachePath, isVanillaFolder, activeGame) with
        | _, _, Custom -> ()
        | Some cp, false, _ ->
            // L7 Fix: use Directory.GetParent() instead of string `+ "/../"` which
            // fails on UNC paths (\\server\share\...) and some symlinked directories.
            let gameCachePath =
                let parent = System.IO.Directory.GetParent(cp)
                if parent <> null then parent.FullName + "/"
                else cp + "/../"

            // P2 Fix: data-driven lookup eliminates ~120 lines of structural duplication.
            // Each entry: (game, cacheFileName, serializeFunction, vanillaPathOption, promptGameName)
            let gameConfig =
                match activeGame with
                | STL  -> Some ("stl",  serializeSTL,  stlVanillaPath,  "stellaris")
                | EU4  -> Some ("eu4",  serializeEU4,  eu4VanillaPath,  "eu4")
                | HOI4 -> Some ("hoi4", serializeHOI4, hoi4VanillaPath, "hoi4")
                | CK2  -> Some ("ck2",  serializeCK2,  ck2VanillaPath,  "ck2")
                | IR   -> Some ("ir",   serializeIR,   irVanillaPath,   "imperator")
                | VIC2 -> Some ("vic2", serializeVIC2, vic2VanillaPath, "vic2")
                | CK3  -> Some ("ck3",  serializeCK3,  ck3VanillaPath,  "ck3")
                | VIC3 -> Some ("vic3", serializeVIC3, vic3VanillaPath, "vic3")
                | EU5  -> Some ("eu5",  serializeEU5,  eu5VanillaPath,  "eu5")
                | Custom -> None

            match gameConfig with
            | None -> ()
            | Some (cacheFile, serializeFn, vanillaPathOpt, promptName) ->
                let doesCacheExist = File.Exists(gameCachePath + cacheFile + ".cwb")

                if doesCacheExist && not forceCreate then
                    logInfo (sprintf "Cache exists at %s" (gameCachePath + ".cwb"))
                else
                    match vanillaPathOpt with
                    | Some vp ->
                        client.CustomNotification(
                            "loadingBar",
                            JsonValue.Record
                                [| "value", JsonValue.String(LangResources.loadingBar_GeneratingVanillaCache)
                                   "enable", JsonValue.Boolean(true) |]
                        )

                        serializeFn vp gameCachePath
                        let text = String.Format(LangResources.vanillaCacheUpdated, activeGame)
                        client.CustomNotification("forceReload", JsonValue.String(text))
                    | None ->
                        client.CustomNotification("promptVanillaPath", JsonValue.String(promptName))
        | _ -> logInfo "No cache path"

    let processWorkspace (uri: option<Uri>) =
        client.CustomNotification(
            "loadingBar",
            JsonValue.Record
                [| "value", JsonValue.String(LangResources.loadingBar_LoadingProject)
                   "enable", JsonValue.Boolean(true) |]
        )

        match uri with
        | Some u ->
            let path = getPathFromDoc u

            try
                let serverSettings =
                    { cachePath = cachePath
                      useManualRules = useManualRules
                      manualRulesFolder = manualRulesFolder
                      isVanillaFolder = isVanillaFolder
                      path = path
                      workspaceFolders = workspaceFolders
                      dontLoadPatterns = dontLoadPatterns
                      validateVanilla = validateVanilla
                      languages = languages
                      experimental = experimental
                      debug_mode = debugMode
                      maxFileSize = maxFileSize
                      stlVanillaPath = stlVanillaPath }

                // 加载新游戏前，清理旧的游戏对象引用释放内存
                let cleanupOldGame () =
                    match gameObj with
                    | Some oldGame ->
                        try
                            let existingFiles = docs.OpenFiles() |> List.map (fun f -> f.FullName) |> Set.ofList
                            oldGame.CleanupCache existingFiles
                        with _ -> ()
                    | None -> ()
                    // 清除所有旧的类型特定引用
                    stlGameObj <- None
                    hoi4GameObj <- None
                    eu4GameObj <- None
                    ck2GameObj <- None
                    irGameObj <- None
                    vic2GameObj <- None
                    ck3GameObj <- None
                    vic3GameObj <- None
                    eu5GameObj <- None
                    customGameObj <- None

                let game =
                    match activeGame with
                    | STL ->
                        cleanupOldGame()
                        let game = loadSTL serverSettings
                        stlGameObj <- Some(game :> IGame<STLComputedData>)
                        game :> IGame
                    | HOI4 ->
                        cleanupOldGame()
                        let game = loadHOI4 serverSettings
                        hoi4GameObj <- Some(game :> IGame<HOI4ComputedData>)
                        game :> IGame
                    | EU4 ->
                        cleanupOldGame()
                        let game = loadEU4 serverSettings
                        eu4GameObj <- Some(game :> IGame<EU4ComputedData>)
                        game :> IGame
                    | CK2 ->
                        cleanupOldGame()
                        let game = loadCK2 serverSettings
                        ck2GameObj <- Some(game :> IGame<CK2ComputedData>)
                        game :> IGame
                    | IR ->
                        cleanupOldGame()
                        let game = loadIR serverSettings
                        irGameObj <- Some(game :> IGame<IRComputedData>)
                        game :> IGame
                    | VIC2 ->
                        cleanupOldGame()
                        let game = loadVIC2 serverSettings
                        vic2GameObj <- Some(game :> IGame<VIC2ComputedData>)
                        game :> IGame
                    | CK3 ->
                        cleanupOldGame()
                        let game = loadCK3 serverSettings
                        ck3GameObj <- Some(game :> IGame<CK3ComputedData>)
                        game :> IGame
                    | VIC3 ->
                        cleanupOldGame()
                        let game = loadVIC3 serverSettings
                        vic3GameObj <- Some(game :> IGame<VIC3ComputedData>)
                        game :> IGame
                    | EU5 ->
                        cleanupOldGame()
                        let game = loadEU5 serverSettings
                        eu5GameObj <- Some(game :> IGame<EU5ComputedData>)
                        game :> IGame
                    | Custom ->
                        cleanupOldGame()
                        let game = loadCustom serverSettings
                        customGameObj <- Some(game :> IGame<JominiComputedData>)
                        game :> IGame

                gameObj <- Some game

                let getRange (start: Position) (endp: Position) =
                    mkRange
                        start.StreamName
                        (mkPos (int start.Line) (int start.Column))
                        (mkPos (int endp.Line) (int endp.Column))

                let parserErrors =
                    game.ParserErrors()
                    |> List.map (fun (n, e, p) -> "CW001", Severity.Error, n, e, (getRange p p), 0, None)

                parserErrors |> List.map parserErrorToDiagnostics |> sendDiagnostics

                let mapResourceToFilePath =
                    function
                    | EntityResource(f, r) -> r.scope, f, r.logicalpath
                    | FileResource(f, r) -> r.scope, f, r.logicalpath
                    | FileWithContentResource(f, r) -> r.scope, f, r.logicalpath

                let fileList =
                    game.AllFiles()
                    |> List.choose (fun resource ->
                        let scope, fileUri, logicalPath = mapResourceToFilePath resource

                        match Uri.TryCreate(fileUri, UriKind.Absolute) with
                        | TrySuccess url -> Some(scope, url, logicalPath)
                        | TryFailure -> None)
                    |> List.map (fun (s, uri, l) ->
                        JsonValue.Record
                            [| "scope", JsonValue.String s
                               "uri", uri.AbsoluteUri |> JsonValue.String
                               "logicalpath", JsonValue.String l |])
                    |> Array.ofList

                client.CustomNotification("updateFileList", JsonValue.Record [| "fileList", JsonValue.Array fileList |])

                client.CustomNotification(
                    "loadingBar",
                    JsonValue.Record
                        [| "value", JsonValue.String(LangResources.loadingBar_ValidatingFiles)
                           "enable", JsonValue.Boolean(true) |]
                )

                let valErrors =
                    game.ValidationErrors()
                    |> List.map (fun e ->
                        (e.code, e.severity, e.range.FileName, e.message, e.range, e.keyLength, e.relatedErrors))

                let locRaw = game.LocalisationErrors(true, true)
                locCache.Clear()
                for fileName, errors in locRaw |> List.groupBy _.range.FileName do
                    locCache.[fileName] <- errors

                let locErrors =
                    locRaw
                    |> List.map (fun e ->
                        (e.code, e.severity, e.range.FileName, e.message, e.range, e.keyLength, e.relatedErrors))

                valErrors @ locErrors |> List.map parserErrorToDiagnostics |> sendDiagnostics
                // L6 Fix: non-blocking optimised GC — avoids a 100ms freeze on load
                GC.Collect(2, System.GCCollectionMode.Optimized, false, false)
            with e ->
                eprintfn $"%A{e}"

        | None -> ()

        client.CustomNotification(
            "loadingBar",
            JsonValue.Record [| "value", JsonValue.String(""); "enable", JsonValue.Boolean(false) |]
        )

        // Notify AI agent that the server is fully ready (game data loaded and validated)
        match gameObj with
        | Some _ ->
            client.CustomNotification(
                "cwtools/serverReady",
                JsonValue.Record
                    [| "game", JsonValue.String(activeGame.ToString())
                       "vanillaLoaded", JsonValue.Boolean(not isVanillaFolder)
                       "timestamp", JsonValue.Number(decimal (System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())) |]
            )
        | None -> ()

    let createRange startLine startCol endLine endCol =
        { start =
            { line = startLine
              character = startCol }
          ``end`` = { line = endLine; character = endCol } }

    let isRangeInError (range: LSP.Types.Range) (start: range) (length: int) =
        range.start.line = (int start.StartLine - 1)
        && range.``end``.line = (int start.StartLine - 1)
        && range.start.character >= int start.StartColumn
        && range.``end``.character <= (int start.StartColumn + length)

    let isRangeInRange (range: LSP.Types.Range) (inner: LSP.Types.Range) =
        (range.start.line < inner.start.line
         || (range.start.line = inner.start.line
             && range.start.character <= inner.start.character))
        && (range.``end``.line > inner.``end``.line
            || (range.``end``.line = inner.``end``.line
                && range.``end``.character >= inner.``end``.character))

    let catchError defaultValue (a: Async<_>) =
        async {
            try
                return! a
            with ex ->
                client.LogMessage
                    { ``type`` = MessageType.Error
                      message = $"%A{ex}" }

                return defaultValue
        }


    let parseUri path =
        let inner p =
            match Uri.TryCreate(p, UriKind.Absolute) with
            | TrySuccess uri -> Some(uri.AbsoluteUri |> JsonValue.String)
            | _ -> None

        memoize id inner path

    interface ILanguageServer with
        member this.Initialize(p: InitializeParams) =
            async {
                rootUri <- p.rootUri
                workspaceFolders <- p.workspaceFolders

                // Check if client supports InsertReplaceEdit
                clientSupportsInsertReplaceEdit <-
                    p.capabilitiesMap.ContainsKey("textDocument.completion.completionItem.insertReplaceSupport")
                    && p.capabilitiesMap.["textDocument.completion.completionItem.insertReplaceSupport"]

                match p.initializationOptions with
                | Some opt ->
                    match opt.Item("language") with
                    | JsonValue.String "stellaris" -> activeGame <- STL
                    | JsonValue.String "hoi4" -> activeGame <- HOI4
                    | JsonValue.String "eu4" -> activeGame <- EU4
                    | JsonValue.String "ck2" -> activeGame <- CK2
                    | JsonValue.String "imperator" -> activeGame <- IR
                    | JsonValue.String "vic2" -> activeGame <- VIC2
                    | JsonValue.String "ck3" -> activeGame <- CK3
                    | JsonValue.String "vic3" -> activeGame <- VIC3
                    | JsonValue.String "eu5" -> activeGame <- EU5
                    | JsonValue.String "paradox" -> activeGame <- Custom
                    | _ -> ()

                    match opt.Item("rulesCache") with
                    | JsonValue.String x ->
                        match activeGame with
                        | STL -> cachePath <- Some(x + "/stellaris")
                        | HOI4 -> cachePath <- Some(x + "/hoi4")
                        | EU4 -> cachePath <- Some(x + "/eu4")
                        | EU5 -> cachePath <- Some(x + "/eu5")
                        | CK2 -> cachePath <- Some(x + "/ck2")
                        | IR -> cachePath <- Some(x + "/imperator")
                        | VIC2 -> cachePath <- Some(x + "/vic2")
                        | VIC3 -> cachePath <- Some(x + "/vic3")
                        | CK3 -> cachePath <- Some(x + "/ck3")
                        | _ -> ()
                    | _ -> ()

                    match opt.Item("repoPath") with
                    | JsonValue.String x ->
                        logInfo $"repo path %A{x}"
                        remoteRepoPath <- Some x
                    | _ -> ()

                    match opt.Item("isVanillaFolder") with
                    | JsonValue.Boolean b ->
                        if b then
                            logInfo "Client thinks this is a vanilla directory"
                        else
                            ()

                        isVanillaFolder <- b
                    | _ -> ()
                    // match opt.Item("rulesVersion") with
                    // | JsonValue.Array x ->
                    //     match x with
                    //     |[|JsonValue.String s; JsonValue.String e|] ->
                    //         stellarisCacheVersion <- Some s
                    //         eu4CacheVersion <- Some e
                    //     | _ -> ()
                    // | _ -> ()
                    match opt.Item("diagnosticLogging") with
                    | JsonValue.Boolean b -> diagnosticLogging <- b
                    | _ -> ()

                    match opt.Item("rules_version") with
                    | JsonValue.String x ->
                        match x with
                        | "manual" ->
                            useManualRules <- true
                            rulesChannel <- "manual"
                        | x -> rulesChannel <- x
                    | _ -> ()

                | None -> ()

                logInfo (sprintf "New init %A" p)

                let triggerChars = LSP.Types.defaultCompletionOptions.triggerCharacters
                logInfo (sprintf "Server initializing. Completion trigger chars configured: %A" triggerChars)
                let caps = [ "."; "|"; "$" ]
                logInfo (sprintf "Sending capabilities with completion trigger chars: %A" caps)

                return
                    { capabilities =
                        { defaultServerCapabilities with
                            hoverProvider = true
                            definitionProvider = true
                            referencesProvider = true
                            documentFormattingProvider = true
                            textDocumentSync =
                                { defaultTextDocumentSyncOptions with
                                    openClose = true
                                    willSave = true
                                    save = Some { includeText = true }
                                    change = TextDocumentSyncKind.Full }
                            completionProvider =
                                Some defaultCompletionOptions
                            codeActionProvider = true
                            codeLensProvider = Some { resolveProvider = true }
                            documentSymbolProvider = true
                            workspaceSymbolProvider = true
                            executeCommandProvider =
                                Some
                                    { commands =
                                        [ "pretriggerThisFile"
                                          "pretriggerAllFiles"
                                          "genlocfile"
                                          "genlocall"
                                          "debugrules"
                                          "outputerrors"
                                          "reloadrulesconfig"
                                          "cacheVanilla"
                                          "listAllFiles"
                                          "listAllLocFiles"
                                          "gettech"
                                          "getGraphData"
                                          "exportTypes"
                                          // A2 Fix: declare ALL implemented AI commands so
                                          // strict LSP clients don't reject them.
                                          "cwtools.ai.getScopeAtPosition"
                                          "cwtools.ai.validateCode"
                                          "cwtools.ai.queryTypes"
                                          "cwtools.ai.queryDefinition"
                                          "cwtools.ai.queryDefinitionByName"
                                          "cwtools.ai.queryScriptedEffects"
                                          "cwtools.ai.queryScriptedTriggers"
                                          "cwtools.ai.queryEnums"
                                          "cwtools.ai.getEntityInfo"
                                          "cwtools.ai.queryStaticModifiers"
                                          "cwtools.ai.queryVariables"
                                          "cwtools.exportTypes"
                                          "typeGraphInfo"
                                          "getFileTypes"
                                          "getDataForFile"
                                          "getTypesForFile" ] }
                            inlayHintProvider = true
                            renameProvider = false
                            semanticTokensProvider =
                                Some
                                    { legend =
                                        { tokenTypes =
                                            [ "namespace"; "type"; "function"; "variable"; "parameter"
                                              "property"; "enumMember"; "keyword"; "number"; "string"
                                              "comment"; "operator"; "macro"; "decorator" ]
                                          tokenModifiers = [ "declaration"; "definition"; "readonly" ] }
                                      full = true } } }
            }

        member this.Initialized() = async { () }
        member this.Shutdown() = async { return None }

        member this.DidChangeConfiguration(p: DidChangeConfigurationParams) =
            async {
                let config = p.settings.Item("cwtools")

                let newLanguages =
                    match config.Item("localisation").Item("languages"), activeGame with
                    | JsonValue.Array o, STL ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s ->
                                (match STLLang.TryParse<STLLang> s with
                                 | TrySuccess s -> Some s
                                 | TryFailure -> None)
                            | _ -> None)
                        |> (fun l -> if Array.isEmpty l then [| STLLang.English |] else l)
                        |> Array.map Lang.STL
                    | _, STL -> [| Lang.STL STLLang.English |]
                    | JsonValue.Array o, EU4 ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s ->
                                (match EU4Lang.TryParse<EU4Lang> s with
                                 | TrySuccess s -> Some s
                                 | TryFailure -> None)
                            | _ -> None)
                        |> (fun l -> if Array.isEmpty l then [| EU4Lang.English |] else l)
                        |> Array.map Lang.EU4
                    | _, EU4 -> [| Lang.EU4 EU4Lang.English |]
                    | JsonValue.Array o, HOI4 ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s ->
                                (match HOI4Lang.TryParse<HOI4Lang> s with
                                 | TrySuccess s -> Some s
                                 | TryFailure -> None)
                            | _ -> None)
                        |> (fun l -> if Array.isEmpty l then [| HOI4Lang.English |] else l)
                        |> Array.map Lang.HOI4
                    | _, HOI4 -> [| Lang.HOI4 HOI4Lang.English |]
                    | JsonValue.Array o, CK2 ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s ->
                                (match CK2Lang.TryParse<CK2Lang> s with
                                 | TrySuccess s -> Some s
                                 | TryFailure -> None)
                            | _ -> None)
                        |> (fun l -> if Array.isEmpty l then [| CK2Lang.English |] else l)
                        |> Array.map Lang.CK2
                    | _, CK2 -> [| Lang.CK2 CK2Lang.English |]
                    | JsonValue.Array o, IR ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s ->
                                (match IRLang.TryParse<IRLang> s with
                                 | TrySuccess s -> Some s
                                 | TryFailure -> None)
                            | _ -> None)
                        |> (fun l -> if Array.isEmpty l then [| IRLang.English |] else l)
                        |> Array.map Lang.IR
                    | _, IR -> [| Lang.IR IRLang.English |]
                    | JsonValue.Array o, VIC2 ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s ->
                                (match VIC2Lang.TryParse<VIC2Lang> s with
                                 | TrySuccess s -> Some s
                                 | TryFailure -> None)
                            | _ -> None)
                        |> (fun l -> if Array.isEmpty l then [| VIC2Lang.English |] else l)
                        |> Array.map Lang.VIC2
                    | _, VIC2 -> [| Lang.VIC2 VIC2Lang.English |]
                    | JsonValue.Array o, CK3 ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s ->
                                (match CK3Lang.TryParse<CK3Lang> s with
                                 | TrySuccess s -> Some s
                                 | TryFailure -> None)
                            | _ -> None)
                        |> (fun l -> if Array.isEmpty l then [| CK3Lang.English |] else l)
                        |> Array.map Lang.CK3
                    | _, CK3 -> [| Lang.CK3 CK3Lang.English |]
                    | JsonValue.Array o, VIC3 ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s ->
                                (match VIC3Lang.TryParse<VIC3Lang> s with
                                 | TrySuccess s -> Some s
                                 | TryFailure -> None)
                            | _ -> None)
                        |> (fun l -> if Array.isEmpty l then [| VIC3Lang.English |] else l)
                        |> Array.map Lang.VIC3
                    | _, VIC3 -> [| Lang.VIC3 VIC3Lang.English |]
                    | JsonValue.Array(o: JsonValue array), EU5 ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s ->
                                (match EU5Lang.TryParse<EU5Lang> s with
                                 | TrySuccess s -> Some s
                                 | TryFailure -> None)
                            | _ -> None)
                        |> (fun l -> if Array.isEmpty l then [| EU5Lang.English |] else l)
                        |> Array.map Lang.EU5
                    | _, EU5 -> [| Lang.EU5 EU5Lang.English |]
                    | _, Custom -> [| Lang.Custom CustomLang.English |]

                languages <- newLanguages

                match config.Item("localisation").Item("generated_strings") with
                | JsonValue.String newString -> generatedStrings <- newString
                | _ -> ()

                let newVanillaOnly =
                    match config.Item("errors").Item("vanilla") with
                    | JsonValue.Boolean b -> b
                    | _ -> false

                validateVanilla <- newVanillaOnly

                let newExperimental =
                    match config.Item("experimental") with
                    | JsonValue.Boolean b -> b
                    | _ -> false

                experimental <- newExperimental

                let newDebugMode =
                    match config.Item("debug_mode") with
                    | JsonValue.Boolean b -> b
                    | _ -> false

                debugMode <- newDebugMode

                let newIgnoreCodes =
                    match config.Item("errors").Item("ignore") with
                    | JsonValue.Array o ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s -> Some s
                            | _ -> None)
                    | _ -> [||]

                ignoreCodes <- newIgnoreCodes

                let newIgnoreFiles =
                    match config.Item("errors").Item("ignorefiles") with
                    | JsonValue.Array o ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s -> Some s
                            | _ -> None)
                    | _ -> [||]

                ignoreFiles <- newIgnoreFiles

                let excludePatterns =
                    match config.Item("ignore_patterns") with
                    | JsonValue.Array o ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s -> Some s
                            | _ -> None)
                    | _ -> [||]

                dontLoadPatterns <- excludePatterns

                match config.Item("trace").Item("server") with
                | JsonValue.String "messages"
                | JsonValue.String "verbose" -> loglevel <- LogLevel.Verbose
                | _ -> ()

                match config.Item("cache").Item("eu4") with
                | JsonValue.String "" -> ()
                | JsonValue.String s -> eu4VanillaPath <- Some s
                | _ -> ()

                match config.Item("cache").Item("stellaris") with
                | JsonValue.String "" -> ()
                | JsonValue.String s -> stlVanillaPath <- Some s
                | _ -> ()

                match config.Item("cache").Item("hoi4") with
                | JsonValue.String "" -> ()
                | JsonValue.String s -> hoi4VanillaPath <- Some s
                | _ -> ()

                match config.Item("cache").Item("ck2") with
                | JsonValue.String "" -> ()
                | JsonValue.String s -> ck2VanillaPath <- Some s
                | _ -> ()

                match config.Item("cache").Item("imperator") with
                | JsonValue.String "" -> ()
                | JsonValue.String s -> irVanillaPath <- Some s
                | _ -> ()

                match config.Item("cache").Item("vic2") with
                | JsonValue.String "" -> ()
                | JsonValue.String s -> vic2VanillaPath <- Some s
                | _ -> ()

                match config.Item("cache").Item("ck3") with
                | JsonValue.String "" -> ()
                | JsonValue.String s -> ck3VanillaPath <- Some s
                | _ -> ()

                match config.Item("cache").Item("vic3") with
                | JsonValue.String "" -> ()
                | JsonValue.String s -> vic3VanillaPath <- Some s
                | _ -> ()

                match config.Item("cache").Item("eu5") with
                | JsonValue.String "" -> ()
                | JsonValue.String s -> eu5VanillaPath <- Some s
                | _ -> ()


                match config.Item("rules_folder") with
                | JsonValue.String x -> manualRulesFolder <- Some x
                | _ -> ()

                match config.Item("showInlineText") with
                | JsonValue.Boolean x -> showInlineText <- x
                | _ -> ()

                match config.Item("maxFileSize") with
                | JsonValue.Number x -> maxFileSize <- int x
                | _ -> ()

                logInfo $"New configuration %s{p.ToString()}"

                match cachePath with
                | Some dir ->
                    if Directory.Exists dir then
                        ()
                    else
                        Directory.CreateDirectory dir |> ignore
                | _ -> ()

                let task =
                    new Task(fun () ->
                        // C3 Fix: processWorkspace mutates gameObj / stlGameObj / etc.
                        // Acquire the write lock so no concurrent read request sees a
                        // half-initialised game object while we are swapping it in.
                        gameStateLock.EnterWriteLock()
                        try
                            setupRulesCaches ()
                            checkOrSetGameCache false
                            processWorkspace rootUri
                        finally
                            gameStateLock.ExitWriteLock())

                task.Start()
            }

        member this.DidOpenTextDocument(p: DidOpenTextDocumentParams) =
            async {
                docs.Open p

                lintAgent.Post(
                    UpdateRequest(
                        { uri = p.textDocument.uri
                          version = p.textDocument.version },
                        true
                    )
                )

                let mapResourceToFilePath =
                    function
                    | EntityResource(f, r) -> r.scope, f, r.logicalpath
                    | FileResource(f, r) -> r.scope, f, r.logicalpath
                    | FileWithContentResource(f, r) -> r.scope, f, r.logicalpath

                match gameObj, currentlyRefreshingFiles with
                | Some game, false ->
                    currentlyRefreshingFiles <- true

                    let task =
                        new Task(fun () ->
                            // M1 Fix: AllFiles() reads internal game state — acquire a shared
                            // read lock so we don't race against a concurrent game reload.
                            gameStateLock.EnterReadLock()
                            try
                                let fileList =
                                    game.AllFiles()
                                    |> List.map mapResourceToFilePath
                                    |> List.choose (fun (s, f, l) -> parseUri f |> Option.map (fun u -> (s, u, l)))
                                    |> List.map (fun (s, uri, l) ->
                                        JsonValue.Record
                                            [| "scope", JsonValue.String s
                                               "uri", uri
                                               "logicalpath", JsonValue.String l |])
                                    |> Array.ofList

                                client.CustomNotification(
                                    "updateFileList",
                                    JsonValue.Record [| "fileList", JsonValue.Array fileList |]
                                )
                            finally
                                gameStateLock.ExitReadLock()
                                // Reset the flag inside the task so writers can see it.
                                currentlyRefreshingFiles <- false)

                    task.Start()
                | _ -> ()
            }

        member this.DidFocusFile(p: DidFocusFileParams) =
            async {
                let path = getPathFromDoc p.uri
                lastFocusedFile <- Some path
                lintAgent.Post(UpdateRequest({ uri = p.uri; version = 0 }, true))
            }

        member this.DidChangeTextDocument(p: DidChangeTextDocumentParams) =
            async {
                docs.Change p

                // Use debounce agent instead of immediate lint.
                // Lint will fire after 1.5s of typing inactivity.
                // This prevents the write lock (game.UpdateFile) from blocking
                // read requests (Completion, Hover, SemanticTokens) during rapid typing.
                lintDebounceAgent.Post(
                    UpdateRequest(
                        { uri = p.textDocument.uri
                          version = p.textDocument.version },
                        false
                    )
                )
            }

        member this.WillSaveTextDocument(p: WillSaveTextDocumentParams) =
            async {
                lintAgent.Post(
                    UpdateRequest(
                        { uri = p.textDocument.uri
                          version = 0 },
                        true
                    )
                )
            }

        // P0 Fix: was TODO() — return empty edit list instead of crashing
        member this.WillSaveWaitUntilTextDocument(_: WillSaveTextDocumentParams) = async { return [] }

        member this.DidSaveTextDocument(p: DidSaveTextDocumentParams) =
            async {
                lintAgent.Post(
                    UpdateRequest(
                        { uri = p.textDocument.uri
                          version = 0 },
                        true
                    )
                )
            }

        member this.DidCloseTextDocument(p: DidCloseTextDocumentParams) = async { docs.Close p }

        member this.DidChangeWatchedFiles(p: DidChangeWatchedFilesParams) =
            async {
                for change in p.changes do
                    match change.``type`` with
                    | FileChangeType.Created -> lintAgent.Post(UpdateRequest({ uri = change.uri; version = 0 }, true))
                    | FileChangeType.Deleted -> client.PublishDiagnostics { uri = change.uri; diagnostics = [] }
                    | _ -> ()
            }

        member this.Completion(p: CompletionParams) =
            async { return completion gameObj p docs debugMode clientSupportsInsertReplaceEdit }
            |> catchError None

        member this.Hover(p: TextDocumentPositionParams) =
            async {
                return
                    (hoverDocument
                        eu4GameObj
                        hoi4GameObj
                        stlGameObj
                        ck2GameObj
                        irGameObj
                        vic2GameObj
                        ck3GameObj
                        vic3GameObj
                        customGameObj
                        docs
                        p.textDocument.uri
                        p.position)
                    |> Async.RunSynchronously
                    |> Some
            }
            |> catchError None

        member this.ResolveCompletionItem(p: CompletionItem) =
            async { return completionResolveItem gameObj p |> Async.RunSynchronously }
            |> catchError p

        member this.SignatureHelp(p: TextDocumentPositionParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let allEffects = game.ScriptedEffects() @ game.ScriptedTriggers()
                        let effectNames = allEffects |> List.map (fun e -> e.Name.GetString()) |> Set.ofList

                        // Try word under cursor first
                        let word = docs.GetTextAtPosition(p.textDocument.uri, p.position)
                        let directMatch =
                            if String.IsNullOrWhiteSpace word then None
                            else allEffects |> List.tryFind (fun e -> e.Name.GetString() = word)

                        // Walk source backwards to find enclosing effect block
                        let findEnclosing () =
                            let fileContent = docs.GetText(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue ""
                            let lines = fileContent.Split('\n')
                            let cursorLine = min p.position.line (lines.Length - 1)
                            let mutable found: string option = None
                            let mutable depth = 0
                            for i in cursorLine .. -1 .. 0 do
                                if found.IsNone then
                                    for ch in lines.[i] do
                                        if ch = '}' then depth <- depth + 1
                                        elif ch = '{' then depth <- depth - 1
                                    if depth < 0 then
                                        let parts = lines.[i].TrimStart().Split([|' '; '='; '\t'|], StringSplitOptions.RemoveEmptyEntries)
                                        if parts.Length > 0 && Set.contains parts.[0] effectNames then
                                            found <- Some parts.[0]
                            found

                        let effectName =
                            match directMatch with
                            | Some e -> Some(e.Name.GetString())
                            | None -> findEnclosing ()

                        match effectName with
                        | Some name ->
                            let effect = allEffects |> List.tryFind (fun e -> e.Name.GetString() = name)
                            match effect with
                            | Some effect ->
                                let paramRegex =
                                    System.Text.RegularExpressions.Regex(
                                        @"\$([A-Za-z_][A-Za-z0-9_]*)\$",
                                        System.Text.RegularExpressions.RegexOptions.Compiled)

                                let comments =
                                    match effect with
                                    | :? ScriptedEffect as se -> se.Comments
                                    | _ -> ""

                                let paramMatches = paramRegex.Matches(comments)
                                let paramNames =
                                    [ for m in paramMatches -> m.Groups.[1].Value ]
                                    |> List.distinct

                                if paramNames.IsEmpty then None
                                else
                                    let parameters =
                                        paramNames
                                        |> List.map (fun pname ->
                                            { label = "$" + pname + "$"
                                              documentation = Some(sprintf "Parameter: %s" pname) })

                                    let scopes =
                                        String.Join(", ", effect.Scopes |> List.map (fun s -> s.ToString()))

                                    let label = name + "(" + String.Join(", ", paramNames) + ")"
                                    let doc =
                                        if String.IsNullOrWhiteSpace scopes then None
                                        else Some(sprintf "Scopes: %s" scopes)

                                    Some
                                        { signatures =
                                            [ { label = label
                                                documentation = doc
                                                parameters = parameters } ]
                                          activeSignature = Some 0
                                          activeParameter = None }
                            | None -> None
                        | None -> None
                    | None -> None
            }
            |> catchError None

        member this.GotoDefinition(p: TextDocumentPositionParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let position = PosHelper.fromZ p.position.line p.position.character
                        logInfo $"goto fn %A{p.textDocument.uri}"
                        let path = getPathFromDoc p.textDocument.uri

                        let gototype =
                            game.GoToType
                                position
                                path
                                (docs.GetText(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue "")

                        match gototype with
                        | Some goto ->
                            logInfo $"goto %s{goto.FileName}"

                            [ { uri = Uri(goto.FileName)
                                range = (convRangeToLSPRange goto) } ]
                        | None -> []
                    | None -> []
            }
            |> catchError []

        member this.FindReferences(p: ReferenceParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let position = PosHelper.fromZ p.position.line p.position.character
                        let path = getPathFromDoc p.textDocument.uri

                        let gototype =
                            game.FindAllRefs
                                position
                                path
                                (docs.GetText(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue "")

                        match gototype with
                        | Some gotos ->
                            gotos
                            |> List.map (fun goto ->
                                { uri = Uri(goto.FileName)
                                  range = (convRangeToLSPRange goto) })
                        | None -> []
                    | None -> []
            }
            |> catchError []

        // P0 Fix: was TODO() — return empty list instead of crashing
        member this.DocumentHighlight(_: TextDocumentPositionParams) = async { return [] }

        member this.DocumentSymbols(p: DocumentSymbolParams) =
            let symbolKindForType (typeName: string) =
                let t = typeName.ToLowerInvariant()
                if t.Contains("event") then SymbolKind.Interface
                elif t.Contains("trigger") then SymbolKind.Function
                elif t.Contains("effect") then SymbolKind.Method
                elif t.Contains("variable") then SymbolKind.Variable
                elif t.Contains("modifier") then SymbolKind.Property
                elif t.Contains("namespace") then SymbolKind.Namespace
                elif t.Contains("decision") || t.Contains("edict") || t.Contains("policy") then SymbolKind.Enum
                elif t.Contains("technology") || t.Contains("component") then SymbolKind.Module
                elif t.Contains("building") || t.Contains("district") then SymbolKind.Constructor
                elif t.Contains("flag") || t.Contains("value") then SymbolKind.Constant
                else SymbolKind.Class

            let createDocumentSymbol name detail kind range =
                let range = convRangeToLSPRange range
                let name = if String.IsNullOrWhiteSpace name then "unnamed" else name

                { name = name
                  detail = detail
                  kind = kind
                  deprecated = false
                  range = range
                  selectionRange = range
                  children = [] }

            async {
                return
                    match gameObj with
                    | Some game ->
                        let types = game.Types()

                        let (all: DocumentSymbol seq) =
                            types
                            |> Map.toList
                            |> Seq.collect (fun (k, vs) ->
                                vs
                                |> Seq.filter (fun tdi -> tdi.range.FileName = p.textDocument.uri.LocalPath)
                                |> Seq.map (fun tdi -> createDocumentSymbol tdi.id k (symbolKindForType k) tdi.range))
                            |> Seq.rev
                            |> Seq.filter (fun ds -> not (ds.detail.Contains(".")))

                        all
                        |> Seq.fold
                            (fun (acc: DocumentSymbol list) (next: DocumentSymbol) ->
                                if
                                    acc
                                    |> List.exists (fun a -> isRangeInRange a.range next.range && a.name <> next.name)
                                then
                                    acc
                                    |> List.map (fun (a: DocumentSymbol) ->
                                        if isRangeInRange a.range next.range && a.name <> next.name then
                                            { a with
                                                children = (next :: a.children) }
                                        else
                                            a)
                                else
                                    next :: acc)
                            []
                    | None -> []
            }
            |> catchError []

        member this.WorkspaceSymbols(p: WorkspaceSymbolParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let types = game.Types()
                        let query = p.query.ToLowerInvariant()

                        types
                        |> Map.toList
                        |> List.collect (fun (typeName, vs) ->
                            if typeName.Contains(".") then []
                            else
                                vs
                                |> Array.toList
                                |> List.filter (fun tdi ->
                                    query.Length = 0
                                    || tdi.id.ToLowerInvariant().Contains(query)
                                    || typeName.ToLowerInvariant().Contains(query))
                                |> List.map (fun tdi ->
                                    { name = tdi.id
                                      kind = SymbolKind.Class
                                      location =
                                        { uri = Uri(tdi.range.FileName)
                                          range = convRangeToLSPRange tdi.range }
                                      containerName = Some typeName }))
                        |> List.truncate 200
                    | None -> []
            }
            |> catchError []

        member this.CodeActions(p: CodeActionParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let path = getPathFromDoc p.textDocument.uri

                        let les =
                            match locCache.TryGetValue(path) with
                            | true, errors -> errors
                            | false, _ -> []

                        let les =
                            les
                            |> List.filter (fun e -> e.range |> (fun a -> (isRangeInError p.range a e.keyLength)))

                        let pretrigger =
                            game.GetPossibleCodeEdits path (docs.GetText(FileInfo(path)) |> Option.defaultValue "")
                            |> List.map convRangeToLSPRange
                            |> List.exists (fun r -> isRangeInRange r p.range)

                        let ces =
                            if pretrigger then
                                [ { title = "Optimise triggers into pretriggers for this file"
                                    command = "pretriggerThisFile"
                                    arguments = [ p.textDocument.uri.LocalPath |> JsonValue.String ] } ]
                            else
                                []

                        match les with
                        | [] -> ces
                        | _ ->
                            ces
                            @ [ { title = "Generate localisation .yml for this file"
                                  command = "genlocfile"
                                  arguments = [ p.textDocument.uri.LocalPath |> JsonValue.String ] }
                                { title = "Generate localisation .yml for all"
                                  command = "genlocall"
                                  arguments = [] } ]
                    | None -> []
            }

        member this.CodeLens(p: CodeLensParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let filePath = p.textDocument.uri.LocalPath
                        // ── Content-hash cache: skip recalc if file unchanged ──
                        let fileText = docs.GetText(FileInfo(filePath)) |> Option.defaultValue ""
                        let hash = contentHash fileText
                        match codeLensCache.TryGetValue(filePath) with
                        | true, (cachedHash, cachedLenses) when cachedHash = hash ->
                            cachedLenses
                        | _ ->
                            let types = game.Types()

                            let lenses =
                                types
                                |> Map.toList
                                |> List.collect (fun (typeName, vs) ->
                                    vs
                                    |> Array.toList
                                    |> List.filter (fun tdi -> tdi.range.FileName = filePath && not (typeName.Contains(".")))
                                    |> List.map (fun tdi ->
                                        let range = convRangeToLSPRange tdi.range
                                        { range = range
                                          command = None
                                          data =
                                            JsonValue.Record
                                                [| "typeName", JsonValue.String typeName
                                                   "id", JsonValue.String tdi.id
                                                   "filePath", JsonValue.String filePath
                                                   "line", JsonValue.Number(decimal range.start.line)
                                                   "character", JsonValue.Number(decimal range.start.character) |] }))

                            codeLensCache.[filePath] <- (hash, lenses)
                            lenses
                    | None -> []
            }
            |> catchError []

        member this.ResolveCodeLens(p: CodeLens) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        try
                            let typeName = p.data.Item("typeName").AsString()
                            let id = p.data.Item("id").AsString()
                            let filePath = p.data.Item("filePath").AsString()
                            let line = p.data.Item("line").AsInteger()
                            let character = p.data.Item("character").AsInteger()
                            let position = PosHelper.fromZ line character

                            let refs =
                                game.FindAllRefs
                                    position
                                    filePath
                                    (docs.GetText(FileInfo(filePath)) |> Option.defaultValue "")

                            let refCount =
                                match refs with
                                | Some gotos -> gotos.Length
                                | None -> 0

                            let title =
                                if refCount = 0 then $"%s{typeName}: %s{id} — no references"
                                elif refCount = 1 then $"%s{typeName}: %s{id} — 1 reference"
                                else $"%s{typeName}: %s{id} — %d{refCount} references"

                            let refLocations =
                                match refs with
                                | Some gotos ->
                                    gotos |> List.map (fun r ->
                                        let range = convRangeToLSPRange r
                                        JsonValue.Record
                                            [| "uri", JsonValue.String(Uri(r.FileName).ToString())
                                               "range", JsonValue.Record
                                                   [| "start", JsonValue.Record
                                                          [| "line", JsonValue.Number(decimal range.start.line)
                                                             "character", JsonValue.Number(decimal range.start.character) |]
                                                      "end", JsonValue.Record
                                                          [| "line", JsonValue.Number(decimal range.``end``.line)
                                                             "character", JsonValue.Number(decimal range.``end``.character) |] |] |])
                                    |> Array.ofList
                                | None -> [||]

                            { p with
                                command =
                                    Some
                                        { title = title
                                          command = "cwtools.showReferences"
                                          arguments =
                                            [ JsonValue.String(Uri(filePath).ToString())
                                              JsonValue.Record
                                                  [| "line", JsonValue.Number(decimal line)
                                                     "character", JsonValue.Number(decimal character) |]
                                              JsonValue.Array(refLocations) ] } }
                        with _ -> p
                    | None -> p
            }
            |> catchError p

        member this.InlayHint(p: InlayHintParams) =
            async {
                if not showInlineText then return []
                else
                    let inlayHintFunction (game: IGame<_>) =
                        let entityOpt = 
                            game.AllEntities() 
                            |> Seq.tryPick (fun struct (e, _) -> if e.filepath = p.textDocument.uri.LocalPath then Some e else None)
                        
                        match entityOpt with
                        | None -> []
                        | Some entity ->
                            let locMap = game.References().Localisation |> Map.ofList
                            let hints = ResizeArray<InlayHint>()
                            let targetPath = entity.filepath

                            // Build scripted variable lookup map
                            let globalVars = game.ScriptedVariables()
                            let fileContent = docs.GetText(FileInfo(targetPath)) |> Option.defaultValue ""
                            let localVarPattern =
                                System.Text.RegularExpressions.Regex(
                                    @"^\s*(@[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n\r#]+)",
                                    System.Text.RegularExpressions.RegexOptions.Multiline)
                            let localVars =
                                [ for m in localVarPattern.Matches(fileContent) ->
                                    m.Groups.[1].Value.Trim(), m.Groups.[2].Value.Trim() ]
                            let varMap = (localVars @ globalVars) |> Map.ofList
                            
                            let formatHintLabel (desc: string) =
                                let clean = desc.Replace("\r\n", " ").Replace("\n", " ").Replace("\\n", " ").Trim()
                                let clean = if clean.StartsWith("\"") && clean.EndsWith("\"") then clean.Substring(1, clean.Length - 2) else clean
                                // Strip Paradox color codes §X
                                let clean = System.Text.RegularExpressions.Regex.Replace(clean, "§[RGBYWHETLMSP!]", "", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
                                let truncated = if clean.Length > 50 then clean.Substring(0, 50) + "..." else clean
                                sprintf "💬 %s" truncated

                            let tryAddVarHint (rawVal: string) (position: CWTools.Utilities.Position.range) =
                                if rawVal.StartsWith("@") && not (rawVal.StartsWith("@[")) then
                                    match Map.tryFind rawVal varMap with
                                    | Some value ->
                                        let range = convRangeToLSPRange position
                                        hints.Add {
                                            position = range.``end``
                                            label = sprintf "= %s" value
                                            paddingLeft = true
                                            paddingRight = false
                                        }
                                    | None -> ()

                            let rec visitNode (n: CWTools.Process.Node) =
                                n.Leaves |> Seq.iter (fun l ->
                                    if l.Position.FileName = targetPath then
                                        let rawVal = l.Value.ToRawString().Trim('\"')
                                        // Localization hint
                                        match Map.tryFind rawVal locMap with
                                        | Some tr ->
                                            let range = convRangeToLSPRange l.Position
                                            hints.Add {
                                                position = range.``end``
                                                label = formatHintLabel tr.desc
                                                paddingLeft = true
                                                paddingRight = false
                                            }
                                        | None -> ()
                                        // Scripted variable hint
                                        tryAddVarHint rawVal l.Position
                                )
                                n.LeafValues |> Seq.iter (fun lv ->
                                    if lv.Position.FileName = targetPath then
                                        let rawVal = lv.Value.ToRawString().Trim('\"')
                                        match Map.tryFind rawVal locMap with
                                        | Some tr ->
                                            let range = convRangeToLSPRange lv.Position
                                            hints.Add {
                                                position = range.``end``
                                                label = formatHintLabel tr.desc
                                                paddingLeft = true
                                                paddingRight = false
                                            }
                                        | None -> ()
                                        tryAddVarHint rawVal lv.Position
                                )
                                n.Nodes |> Seq.iter visitNode

                            visitNode entity.entity
                            
                            hints 
                            |> Seq.distinctBy (fun h -> h.position.line, h.label)
                            |> Seq.toList
                        
                    return
                        match
                            stlGameObj,
                            hoi4GameObj,
                            eu4GameObj,
                            ck2GameObj,
                            irGameObj,
                            vic2GameObj,
                            ck3GameObj,
                            vic3GameObj,
                            customGameObj
                        with
                        | Some game, _, _, _, _, _, _, _, _ -> inlayHintFunction game
                        | _, Some game, _, _, _, _, _, _, _ -> inlayHintFunction game
                        | _, _, Some game, _, _, _, _, _, _ -> inlayHintFunction game
                        | _, _, _, Some game, _, _, _, _, _ -> inlayHintFunction game
                        | _, _, _, _, Some game, _, _, _, _ -> inlayHintFunction game
                        | _, _, _, _, _, Some game, _, _, _ -> inlayHintFunction game
                        | _, _, _, _, _, _, Some game, _, _ -> inlayHintFunction game
                        | _, _, _, _, _, _, _, Some game, _ -> inlayHintFunction game
                        | _, _, _, _, _, _, _, _, Some game -> inlayHintFunction game
                        | _ -> []
            }
            |> catchError []
        // P0 Fix: was TODO() — return empty list / identity instead of crashing
        member this.DocumentLink(_: DocumentLinkParams) = async { return [] }
        member this.ResolveDocumentLink(link: DocumentLink) = async { return link }

        member this.SemanticTokensFull(p: SemanticTokensParams) =
            // Token type indices (must match legend in capabilities):
            // 0=namespace, 1=type, 2=function, 3=variable, 4=parameter,
            // 5=property, 6=enumMember, 7=keyword, 8=number, 9=string,
            // 10=comment, 11=operator, 12=macro, 13=decorator
            // Effect keys -> 2(function), Trigger keys -> 1(type)
            async {
                let semanticTokensFunction (game: IGame<_>) =
                    // ── Content-hash cache: skip full AST traversal if file unchanged ──
                    let filePath = p.textDocument.uri.LocalPath
                    let fileText = docs.GetText(FileInfo(filePath)) |> Option.defaultValue ""
                    let hash = contentHash fileText
                    match semanticTokensCache.TryGetValue(filePath) with
                    | true, (cachedHash, cachedData) when cachedHash = hash ->
                        Some { data = cachedData }
                    | _ ->
                    let entityOpt =
                        game.AllEntities()
                        |> Seq.tryPick (fun struct (e, _) ->
                            if e.filepath = filePath then Some e else None)

                    match entityOpt with
                    | None ->
                        // Entity not yet available (AST rebuild in progress).
                        // Return stale cached data to keep highlighting stable.
                        match semanticTokensCache.TryGetValue(filePath) with
                        | true, (_, cachedData) -> Some { data = cachedData }
                        | _ -> None
                    | Some entity ->
                        let tokens = ResizeArray<struct (int * int * int * int * int)>()
                        let fileContent = fileText
                        let lines = fileContent.Split('\n')

                        // Collect known names for classification
                        let allEffects = game.ScriptedEffects() |> List.map (fun e -> e.Name.GetString()) |> Set.ofList
                        let allTriggers = game.ScriptedTriggers() |> List.map (fun e -> e.Name.GetString()) |> Set.ofList

                        // Walk AST — only classify Leaves and LeafValues
                        // Verify against source text to avoid position mismatches
                        let verifyAndAdd (line: int) (col: int) (len: int) (tokenType: int) =
                            if line >= 0 && line < lines.Length then
                                let srcLine = lines.[line]
                                if col >= 0 && col + len <= srcLine.Length then
                                    tokens.Add(struct (line, col, len, tokenType, 0))

                        let rec visitNode (n: CWTools.Process.Node) =

                            n.Leaves |> Seq.iter (fun l ->
                                if l.Position.FileName = filePath then
                                    let line = max 0 (int l.Position.StartLine - 1)
                                    let col = int l.Position.StartColumn
                                    let key = l.Key
                                    let rawVal = l.Value.ToRawString()

                                    // Verify key against source, find actual position
                                    if key.Length > 0 && line < lines.Length then
                                        let srcLine = lines.[line]
                                        // Find key in source starting from col
                                        let actualCol =
                                            if col >= 0 && col + key.Length <= srcLine.Length && srcLine.Substring(col, key.Length) = key then
                                                col
                                            else
                                                // Search from AST column position, not from line start
                                                let idx = srcLine.IndexOf(key, max 0 col)
                                                if idx >= 0 then idx
                                                else
                                                    let idx2 = srcLine.IndexOf(key)
                                                    if idx2 >= 0 then idx2 else -1
                                        if actualCol >= 0 then
                                            let keyType =
                                                if key.StartsWith("@") then 3
                                                elif key.StartsWith("$") && key.EndsWith("$") then 4
                                                elif Set.contains key allEffects then 2
                                                elif Set.contains key allTriggers then 1
                                                elif key = "if" || key = "else" || key = "else_if"
                                                    || key = "AND" || key = "OR" || key = "NOT"
                                                    || key = "NOR" || key = "NAND"
                                                    || key = "limit" || key = "trigger"
                                                    || key = "modifier" || key = "while"
                                                    || key = "switch" || key = "every"
                                                    || key = "random" || key = "random_list"
                                                    || key = "inline_script" then 7
                                                else 5
                                            verifyAndAdd line actualCol key.Length keyType

                                    // Value: find in source text on the end line
                                    let valLine = max 0 (int l.Position.EndLine - 1)
                                    if valLine < lines.Length && rawVal.Length > 0 then
                                        let cleanVal = rawVal.Trim('"')
                                        let srcLine = lines.[valLine]
                                        // Find value text in the source line
                                        let mutable dummy = 0.0
                                        let valType =
                                            if rawVal.StartsWith("@") then 3
                                            elif rawVal.StartsWith("$") && rawVal.EndsWith("$") then 4
                                            elif rawVal = "yes" || rawVal = "no" then 7
                                            elif System.Double.TryParse(rawVal, &dummy) then 8
                                            else 6
                                        // Find the actual position of the value using AST end position hint
                                        let searchVal = if rawVal.StartsWith("\"") then cleanVal else rawVal
                                        if searchVal.Length > 0 then
                                            let endCol = int l.Position.EndColumn
                                            // Try AST-provided end position first (value ends at EndColumn)
                                            let valStartHint = max 0 (endCol - searchVal.Length)
                                            let actualValCol =
                                                if valStartHint >= 0 && valStartHint + searchVal.Length <= srcLine.Length && srcLine.Substring(valStartHint, searchVal.Length) = searchVal then
                                                    valStartHint
                                                else
                                                    // Fallback: search from after the key position
                                                    let searchFrom = max 0 (col + key.Length)
                                                    let idx = srcLine.IndexOf(searchVal, searchFrom)
                                                    if idx >= 0 then idx else -1
                                            if actualValCol >= 0 then
                                                verifyAndAdd valLine actualValCol searchVal.Length valType
                            )

                            n.LeafValues |> Seq.iter (fun lv ->
                                if lv.Position.FileName = filePath then
                                    let line = max 0 (int lv.Position.StartLine - 1)
                                    let col = int lv.Position.StartColumn
                                    let rawVal = lv.Value.ToRawString()
                                    let valLen = rawVal.Trim('"').Length
                                    if valLen > 0 then
                                        let valType =
                                            if rawVal.StartsWith("@") then 3
                                            elif rawVal.StartsWith("$") && rawVal.EndsWith("$") then 4
                                            elif rawVal = "yes" || rawVal = "no" then 7
                                            else 6
                                        verifyAndAdd line col valLen valType
                            )

                            // Generate tokens for Node keys (e.g. effect = { ... }, trigger = { ... })
                            n.Nodes |> Seq.iter (fun childNode ->
                                if childNode.Position.FileName = filePath then
                                    let nLine = max 0 (int childNode.Position.StartLine - 1)
                                    let nCol = int childNode.Position.StartColumn
                                    let nKey = childNode.Key
                                    if nKey.Length > 0 && nLine < lines.Length then
                                        let srcLine = lines.[nLine]
                                        let actualCol =
                                            if nCol >= 0 && nCol + nKey.Length <= srcLine.Length && srcLine.Substring(nCol, nKey.Length) = nKey then
                                                nCol
                                            else
                                                let idx = srcLine.IndexOf(nKey, max 0 nCol)
                                                if idx >= 0 then idx
                                                else
                                                    let idx2 = srcLine.IndexOf(nKey)
                                                    if idx2 >= 0 then idx2 else -1
                                        if actualCol >= 0 then
                                            let keyType =
                                                if nKey.StartsWith("@") then 3
                                                elif nKey.StartsWith("$") && nKey.EndsWith("$") then 4
                                                elif Set.contains nKey allEffects then 2
                                                elif Set.contains nKey allTriggers then 1
                                                elif nKey = "if" || nKey = "else" || nKey = "else_if"
                                                    || nKey = "AND" || nKey = "OR" || nKey = "NOT"
                                                    || nKey = "NOR" || nKey = "NAND"
                                                    || nKey = "limit" || nKey = "trigger"
                                                    || nKey = "modifier" || nKey = "while"
                                                    || nKey = "switch" || nKey = "every"
                                                    || nKey = "random" || nKey = "random_list"
                                                    || nKey = "inline_script" then 7
                                                else 5
                                            verifyAndAdd nLine actualCol nKey.Length keyType
                                visitNode childNode
                            )

                        visitNode entity.entity

                        // Scan for comments
                        lines |> Array.iteri (fun lineIdx lineText ->
                            let trimmed = lineText.TrimStart()
                            if trimmed.StartsWith("#") then
                                let col = lineText.Length - trimmed.Length
                                tokens.Add(struct (lineIdx, col, lineText.Length - col, 10, 0))
                        )

                        // Sort and encode as delta format
                        let sorted =
                            tokens
                            |> Seq.toArray
                            |> Array.sortBy (fun struct (l, c, _, _, _) -> l, c)

                        let data = ResizeArray<int>()
                        let mutable prevLine = 0
                        let mutable prevChar = 0

                        for struct (line, col, len, tokenType, mods) in sorted do
                            let deltaLine = line - prevLine
                            let deltaChar = if deltaLine = 0 then col - prevChar else col
                            data.Add(deltaLine)
                            data.Add(deltaChar)
                            data.Add(len)
                            data.Add(tokenType)
                            data.Add(mods)
                            prevLine <- line
                            prevChar <- col

                        let dataList = data |> Seq.toList
                        semanticTokensCache.[filePath] <- (hash, dataList)
                        Some { data = dataList }

                return
                    match
                        stlGameObj,
                        hoi4GameObj,
                        eu4GameObj,
                        ck2GameObj,
                        irGameObj,
                        vic2GameObj,
                        ck3GameObj,
                        vic3GameObj,
                        customGameObj
                    with
                    | Some game, _, _, _, _, _, _, _, _ -> semanticTokensFunction game
                    | _, Some game, _, _, _, _, _, _, _ -> semanticTokensFunction game
                    | _, _, Some game, _, _, _, _, _, _ -> semanticTokensFunction game
                    | _, _, _, Some game, _, _, _, _, _ -> semanticTokensFunction game
                    | _, _, _, _, Some game, _, _, _, _ -> semanticTokensFunction game
                    | _, _, _, _, _, Some game, _, _, _ -> semanticTokensFunction game
                    | _, _, _, _, _, _, Some game, _, _ -> semanticTokensFunction game
                    | _, _, _, _, _, _, _, Some game, _ -> semanticTokensFunction game
                    | _, _, _, _, _, _, _, _, Some game -> semanticTokensFunction game
                    | _ -> None
            }
            |> catchError None

        member this.DocumentFormatting(p: DocumentFormattingParams) =
            async {
                let path =
                    if
                        RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                        && p.textDocument.uri.LocalPath.StartsWith '/'
                    then
                        p.textDocument.uri.LocalPath.Substring(1)
                    else
                        p.textDocument.uri.LocalPath

                let fileText = docs.GetText(FileInfo(p.textDocument.uri.LocalPath))

                match fileText with
                | Some fileText ->
                    match
                        CKParser.parseString fileText path,
                        Path.GetExtension(path.AsSpan()).Equals(".gui", StringComparison.OrdinalIgnoreCase)
                        || Path.GetExtension(path.AsSpan()).Equals(".yml", StringComparison.OrdinalIgnoreCase)
                    with
                    | Success(sl, _, _), false ->
                        let formatted = CKPrinter.printTopLevelKeyValueList sl

                        return
                            [ { range = createRange 0 0 100000 0
                                newText = formatted } ]
                    | _ -> return []
                | None -> return []
            }
            |> catchError []

        // P0 Fix: was TODO() — return empty results / no-op instead of crashing
        member this.DocumentRangeFormatting(_: DocumentRangeFormattingParams) = async { return [] }
        member this.DocumentOnTypeFormatting(_: DocumentOnTypeFormattingParams) = async { return [] }
        member this.DidChangeWorkspaceFolders(_: DidChangeWorkspaceFoldersParams) = async { () }
        member this.Rename(p: RenameParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let position = PosHelper.fromZ p.position.line p.position.character
                        let path = getPathFromDoc p.textDocument.uri

                        let refs =
                            game.FindAllRefs
                                position
                                path
                                (docs.GetText(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue "")

                        match refs with
                        | Some gotos when gotos.Length > 0 ->
                            let changes =
                                gotos
                                |> List.groupBy (fun r -> r.FileName)
                                |> List.map (fun (fileName, ranges) ->
                                    let uri = Uri(fileName).ToString()
                                    let edits =
                                        ranges
                                        |> List.map (fun r ->
                                            { range = convRangeToLSPRange r
                                              newText = p.newName })
                                    uri, edits)
                                |> Map.ofList

                            { documentChanges = []; changes = changes }
                        | _ -> { documentChanges = []; changes = Map.empty }
                    | None -> { documentChanges = []; changes = Map.empty }
            }
            |> catchError { documentChanges = []; changes = Map.empty }

        member this.ExecuteCommand(p: ExecuteCommandParams) : Async<ExecuteCommandResponse option> =
            async {
                return
                    match gameObj with
                    | Some game ->
                        match p with
                        | { command = "genlocfile"
                            arguments = x :: _ } ->
                            let les =
                                game.LocalisationErrors(true, true)
                                |> List.filter (fun e -> e.range |> (fun a -> a.FileName = x.AsString()))

                            let keys =
                                les
                                |> List.sortBy (fun e -> (e.range.FileName, e.range.StartLine))
                                |> List.choose (fun e -> e.data)
                                |> List.map (fun lockey -> $" %s{lockey}%s{generatedStrings}")
                                |> List.distinct

                            let text = String.Join(Environment.NewLine, keys)

                            client.CustomNotification(
                                "createVirtualFile",
                                JsonValue.Record
                                    [| "uri", JsonValue.String("cwtools://1")
                                       "fileContent", JsonValue.String(text) |]
                            )

                            None
                        | { command = "genlocall"; arguments = _ } ->
                            let les = game.LocalisationErrors(true, true)

                            let keys =
                                les
                                |> List.sortBy (fun e -> (e.range.FileName, e.range.StartLine))
                                |> List.choose (fun e -> e.data)
                                |> List.map (fun lockey -> $" %s{lockey}%s{generatedStrings}")
                                |> List.distinct

                            let text = String.Join(Environment.NewLine, keys)

                            client.CustomNotification(
                                "createVirtualFile",
                                JsonValue.Record
                                    [| "uri", JsonValue.String("cwtools://1")
                                       "fileContent", JsonValue.String(text) |]
                            )

                            None
                        | { command = "debugrules"
                            arguments = _ } ->
                            match irGameObj, hoi4GameObj with
                            | Some ir, _ ->
                                let text =
                                    ir.References().ConfigRules
                                    |> Seq.map _.ToString()
                                    |> (fun l -> String.Join('\n', l))

                                client.CustomNotification(
                                    "createVirtualFile",
                                    JsonValue.Record
                                        [| "uri", JsonValue.String("cwtools://1")
                                           "fileContent", JsonValue.String(text) |]
                                )
                            | _, Some hoi4 ->
                                let text =
                                    hoi4.References().ConfigRules
                                    |> Seq.map _.ToString()
                                    |> (fun l -> String.Join('\n', l))
                                // let text = sprintf "%O" (ir.References().ConfigRules)
                                client.CustomNotification(
                                    "createVirtualFile",
                                    JsonValue.Record
                                        [| "uri", JsonValue.String("cwtools://1")
                                           "fileContent", JsonValue.String(text) |]
                                )
                            | None, None -> ()

                            None

                        | { command = "outputerrors"
                            arguments = _ } ->
                            let errors = game.LocalisationErrors(true, true) @ game.ValidationErrors()

                            let texts =
                                errors
                                |> List.map (fun e ->
                                    $"%s{e.range.FileName}, {e.range.StartLine}, {e.range.StartColumn}, %s{e.code}, {e.severity}, \"%s{e.message}\"")

                            let text = String.Join(Environment.NewLine, texts)

                            client.CustomNotification(
                                "createVirtualFile",
                                JsonValue.Record
                                    [| "uri", JsonValue.String("cwtools://errors.csv")
                                       "fileContent", JsonValue.String(text) |]
                            )

                            None
                        | { command = "reloadrulesconfig"
                            arguments = _ } ->
                            let configs = getConfigFiles cachePath useManualRules manualRulesFolder
                            game.ReplaceConfigRules configs
                            None
                        | { command = "cacheVanilla"
                            arguments = _ } ->
                            checkOrSetGameCache true
                            None
                        | { command = "listAllFiles"
                            arguments = _ } ->
                            let resources = game.AllFiles()

                            let text =
                                resources
                                |> List.map (fun r ->
                                    match r with
                                    | EntityResource(f, _) -> f
                                    | FileResource(f, _) -> f
                                    | FileWithContentResource(f, _) -> f)

                            let text = String.Join(Environment.NewLine, text)

                            client.CustomNotification(
                                "createVirtualFile",
                                JsonValue.Record
                                    [| "uri", JsonValue.String("cwtools://allfiles")
                                       "fileContent", JsonValue.String(text) |]
                            )

                            None
                        | { command = "listAllLocFiles"
                            arguments = _ } ->
                            let locs = game.AllLoadedLocalisation()
                            let text = String.Join(Environment.NewLine, locs)

                            client.CustomNotification(
                                "createVirtualFile",
                                JsonValue.Record
                                    [| "uri", JsonValue.String("cwtools://alllocfiles")
                                       "fileContent", JsonValue.String(text) |]
                            )

                            None
                        | { command = "pretriggerAllFiles"
                            arguments = _ } ->
                            let files = game.AllFiles()

                            let filteredFiles =
                                files
                                |> List.choose (function
                                    | EntityResource(_, e) -> Some e
                                    | _ -> None)
                                |> List.filter (fun e ->
                                    e.logicalpath.StartsWith "events/"
                                    && e.scope <> "vanilla"
                                    && e.scope <> "embedded")
                                |> List.map (fun f -> f.filepath)

                            filteredFiles |> List.iter (pretriggerForFile client game docs)
                            None
                        | { command = "pretriggerThisFile"
                            arguments = x :: _ } ->
                            let filename = x.AsString()
                            pretriggerForFile client game docs filename
                            None
                        | { command = "gettech"; arguments = _ } ->
                            match stlGameObj with
                            | Some game ->
                                let techs = game.References().Technologies

                                let techJson =
                                    techs
                                    |> List.map (fun (k, p) ->
                                        JsonValue.Record
                                            [| "name", JsonValue.String k
                                               "prereqs",
                                               JsonValue.Array(p |> Array.ofList |> Array.map JsonValue.String) |])
                                    |> Array.ofList
                                    |> JsonValue.Array

                                Some techJson
                            | None -> None
                        | { command = "getGraphData"
                            arguments = x :: depth :: _ } ->
                            match lastFocusedFile with
                            | Some lastFile ->
                                let events =
                                    game.GetEventGraphData [ lastFile ] (x.AsString()) (depth.AsString() |> int)

                                let graphData: GraphTypes.GraphData =
                                    events
                                    |> List.map (fun e ->
                                        { GraphTypes.GraphNode.id = e.id
                                          displayName = e.displayName
                                          references =
                                            e.references
                                            |> List.map (fun (name, isOutgoing, label) ->
                                                { GraphTypes.GraphReference.key = name
                                                  isOutgoing = isOutgoing
                                                  label = label })
                                          location = e.location
                                          documentation = e.documentation
                                          details = e.details
                                          isPrimary = e.isPrimary
                                          entityType = e.entityType
                                          entityTypeDisplayName = e.entityTypeDisplayName
                                          abbreviation = e.abbreviation })

                                Some(GraphTypes.graphDataToJson graphData)
                            | None -> None
                        | { command = "getFileTypes"
                            arguments = _ } ->
                            match lastFocusedFile with
                            | Some lastFile ->
                                let typesWithGraph =
                                    game.TypeDefs()
                                    |> List.filter (fun td -> td.graphRelatedTypes.Length > 0)
                                    |> List.map (fun x -> x.name)

                                let types = game.Types()

                                let (all: string seq) =
                                    types
                                    |> Map.toList
                                    |> Seq.filter (fun (k, _) -> typesWithGraph |> List.contains k)
                                    |> Seq.collect (fun (k, vs) ->
                                        vs
                                        |> Seq.filter (fun tdi -> tdi.range.FileName = lastFile)
                                        |> Seq.map (fun _ -> k))
                                    |> Seq.filter (fun ds -> not (ds.Contains(".")))

                                Some(all |> Seq.map JsonValue.String |> Array.ofSeq |> JsonValue.Array)
                            | None -> None
                        | { command = "exportTypes"
                            arguments = _ } ->
                            match gameObj with
                            | Some game ->
                                let header = "type,name,file,line" + Environment.NewLine

                                let res =
                                    game.Types()
                                    |> Map.toList
                                    |> Seq.collect (fun (s, vs) -> vs |> Seq.map (fun v -> s, v))

                                let text =
                                    res
                                    |> Seq.map (fun (t, td) ->
                                        sprintf
                                            "%s,%s,%s,%A"
                                            t
                                            td.id
                                            (td.range.FileName.Replace('\\', '/'))
                                            td.range.StartLine)
                                    |> String.concat Environment.NewLine

                                client.CustomNotification(
                                    "createVirtualFile",
                                    JsonValue.Record
                                        [| "uri", JsonValue.String("cwtools://alltypes")
                                           "fileContent", JsonValue.String(header + text) |]
                                )

                                None
                            | _ -> None
                        // ── AI-specific structured query commands ────────────────────────────

                        | { command = "cwtools.ai.getScopeAtPosition"
                            arguments = uriArg :: lineArg :: colArg :: _ } ->
                            // Returns structured scope JSON without Markdown parsing
                            let filePath =
                                let raw = uriArg.AsString()
                                let uri = Uri(raw)
                                getPathFromDoc uri
                            let line = lineArg.AsInteger()
                            let col  = colArg.AsInteger()
                            let position = PosHelper.fromZ line col
                            let fileContent =
                                match docs.GetText(FileInfo(filePath)) with
                                | Some t -> t
                                | None -> try File.ReadAllText filePath with _ -> ""
                            let scopeResult =
                                match gameObj with
                                | Some g ->
                                    match g.ScopesAtPos position filePath fileContent with
                                    | Some scopes ->
                                        let thisScopeStr =
                                            scopes.Scopes |> List.tryHead |> Option.map string |> Option.defaultValue "unknown"
                                        let prevChain =
                                            scopes.Scopes
                                            |> List.tail
                                            |> List.map string
                                            |> Array.ofList
                                        let fromChain =
                                            scopes.From |> List.map string |> Array.ofList
                                        JsonValue.Record
                                            [| "thisScope",  JsonValue.String thisScopeStr
                                               "root",       JsonValue.String (scopes.Root.ToString())
                                               "currentScope", JsonValue.String thisScopeStr
                                               "prevChain",  JsonValue.Array(prevChain |> Array.map JsonValue.String)
                                               "fromChain",  JsonValue.Array(fromChain |> Array.map JsonValue.String)
                                               "ok",         JsonValue.Boolean true |]
                                    | None ->
                                        JsonValue.Record
                                            [| "thisScope", JsonValue.String "unknown"
                                               "root",      JsonValue.String "unknown"
                                               "currentScope", JsonValue.String "unknown"
                                               "prevChain", JsonValue.Array [||]
                                               "fromChain", JsonValue.Array [||]
                                               "ok",        JsonValue.Boolean false |]
                                | None ->
                                    JsonValue.Record
                                        [| "ok", JsonValue.Boolean false
                                           "error", JsonValue.String "LSP server not ready" |]
                            Some scopeResult

                        | { command = "cwtools.ai.validateCode"
                            arguments = codeArg :: targetFileArg :: _ } ->
                            // In-memory code validation — no temp files, no 3s wait
                            // Uses WRITE LOCK because UpdateFile mutates internal AST+error caches
                            let code       = codeArg.AsString()
                            let targetFile = targetFileArg.AsString()
                            let errorsJson =
                                match gameObj with
                                | Some g ->
                                    gameStateLock.EnterWriteLock()
                                    try
                                        // Save original content so we can restore after temp validation
                                        let originalContent =
                                            match docs.GetText(FileInfo(targetFile)) with
                                            | Some t -> Some t
                                            | None   -> try Some(File.ReadAllText targetFile) with _ -> None

                                        // Build validation content: append AI code to existing file
                                        let validationContent =
                                            match originalContent with
                                            | Some orig -> orig + "\n\n" + code
                                            | None      -> code
                                        // M3 Fix: count lines using bare \n split to match
                                        // the validationContent separator ("\n\n").
                                        let originalLineCount =
                                            match originalContent with
                                            | Some orig ->
                                                orig.Split([|'\n'|], StringSplitOptions.None).Length + 2 // +2 for \n\n separator
                                            | None      -> 0

                                        // M6 Fix: use a mutable to hold errors so the restore
                                        // always executes regardless of whether Update throws.
                                        let mutable rawErrors: CWError list = []
                                        try
                                            rawErrors <- g.UpdateFile true targetFile (Some validationContent)
                                        with _ -> rawErrors <- []

                                        // Restore original content unconditionally
                                        match originalContent with
                                        | Some orig ->
                                            try g.UpdateFile true targetFile (Some orig) |> ignore
                                            with _ -> ()
                                        | None -> ()

                                        // Filter and adjust line numbers
                                        let adjustedErrors =
                                            rawErrors
                                            |> List.choose (fun e ->
                                                let adjustedLine = int e.range.StartLine - 1 - originalLineCount
                                                if adjustedLine < 0 then None
                                                else
                                                    let sevStr =
                                                        match e.severity with
                                                        | Severity.Error       -> "error"
                                                        | Severity.Warning     -> "warning"
                                                        | Severity.Information -> "info"
                                                        | _                    -> "hint"
                                                    Some (JsonValue.Record
                                                        [| "code",     JsonValue.String e.code
                                                           "severity", JsonValue.String sevStr
                                                           "message",  JsonValue.String e.message
                                                           "line",     JsonValue.Number(decimal adjustedLine)
                                                           "column",   JsonValue.Number(decimal (int e.range.StartColumn)) |]))

                                        let hasErrors =
                                            adjustedErrors |> List.exists (fun e ->
                                                match e.["severity"] with JsonValue.String "error" -> true | _ -> false)

                                        JsonValue.Record
                                            [| "isValid", JsonValue.Boolean(not hasErrors)
                                               "errors",  JsonValue.Array(adjustedErrors |> Array.ofList)
                                               "ok",      JsonValue.Boolean true |]
                                    finally
                                        gameStateLock.ExitWriteLock()
                                | None ->
                                    JsonValue.Record
                                        [| "ok",    JsonValue.Boolean false
                                           "error", JsonValue.String "LSP server not ready" |]
                            Some errorsJson



                        | { command = "cwtools.ai.queryTypes"
                            arguments = typeNameArg :: rest } ->
                            // Query type instances from game's type map (includes vanilla cache)
                            let typeName    = typeNameArg.AsString()
                            let filterStr   = rest |> List.tryItem 0 |> Option.bind (fun j -> match j with JsonValue.String s when s <> "" -> Some s | _ -> None)
                            let limitVal    = rest |> List.tryItem 1 |> Option.bind (fun j -> match j with JsonValue.Number n -> Some(int n) | _ -> None) |> Option.defaultValue 50
                            let vanillaOnly = rest |> List.tryItem 2 |> Option.bind (fun j -> match j with JsonValue.Boolean b -> Some b | _ -> None) |> Option.defaultValue false

                            let resultJson =
                                match gameObj with
                                | Some g ->
                                    let typeMap = g.Types()
                                    match typeMap |> Map.tryFind typeName with
                                    | None ->
                                        JsonValue.Record
                                            [| "typeName",   JsonValue.String typeName
                                               "instances",  JsonValue.Array [||]
                                               "totalCount", JsonValue.Number 0m
                                               "ok",         JsonValue.Boolean true |]
                                    | Some typeArr ->
                                        // Single filter pass → reuse for both count and truncated result
                                        let filtered =
                                            typeArr
                                            |> Array.filter (fun td ->
                                                let scopeOk = if vanillaOnly then td.range.FileName.Contains("cache") || td.range.FileName.Contains("vanilla") else true
                                                let filterOk =
                                                    match filterStr with
                                                    | None -> true
                                                    | Some f -> td.id.StartsWith(f, StringComparison.OrdinalIgnoreCase)
                                                scopeOk && filterOk)
                                        let allCount = filtered.Length
                                        let instances =
                                            filtered
                                            |> Array.truncate limitVal
                                            |> Array.map (fun td ->
                                                let filePath = td.range.FileName.Replace('\\', '/')
                                                let isVanilla = filePath.Contains("cache") || filePath.Contains("vanilla")
                                                JsonValue.Record
                                                    [| "id",      JsonValue.String td.id
                                                       "file",    JsonValue.String filePath
                                                       "line",    JsonValue.Number(decimal (int td.range.StartLine))
                                                       "vanilla", JsonValue.Boolean isVanilla |])
                                        JsonValue.Record
                                            [| "typeName",   JsonValue.String typeName
                                               "instances",  JsonValue.Array instances
                                               "totalCount", JsonValue.Number(decimal allCount)
                                               "ok",         JsonValue.Boolean true |]
                                | None ->
                                    JsonValue.Record
                                        [| "ok", JsonValue.Boolean false
                                           "error", JsonValue.String "LSP server not ready" |]
                            Some resultJson


                        // ── cwtools.ai.queryDefinition ────────────────────────────────────────────
                        // GoToType + FindAllRefs directly from the AST (replaces file-system grep)
                        | { command = "cwtools.ai.queryDefinition"
                            arguments = uriArg :: lineArg :: colArg :: _ } ->
                            let filePath =
                                let raw = uriArg.AsString()
                                getPathFromDoc (Uri(raw))
                            let line = lineArg.AsInteger()
                            let col  = colArg.AsInteger()
                            let position = PosHelper.fromZ line col
                            let fileContent =
                                match docs.GetText(FileInfo(filePath)) with
                                | Some t -> t
                                | None   -> try File.ReadAllText filePath with _ -> ""
                            let result =
                                match gameObj with
                                | Some g ->
                                    // Try jump-to-definition first
                                    match g.GoToType position filePath fileContent with
                                    | Some rng ->
                                        JsonValue.Record
                                            [| "kind", JsonValue.String "definition"
                                               "file", JsonValue.String (rng.FileName.Replace('\\', '/'))
                                               "line", JsonValue.Number(decimal (int rng.StartLine))
                                               "col",  JsonValue.Number(decimal (int rng.StartColumn))
                                               "ok",   JsonValue.Boolean true |]
                                    | None ->
                                        // Fall back to find-all-refs
                                        match g.FindAllRefs position filePath fileContent with
                                        | Some refs ->
                                            let refsArr =
                                                refs
                                                |> List.map (fun r ->
                                                    JsonValue.Record
                                                        [| "file", JsonValue.String (r.FileName.Replace('\\', '/'))
                                                           "line", JsonValue.Number(decimal (int r.StartLine))
                                                           "col",  JsonValue.Number(decimal (int r.StartColumn)) |])
                                                |> Array.ofList
                                            JsonValue.Record
                                                [| "kind",  JsonValue.String "references"
                                                   "refs",  JsonValue.Array refsArr
                                                   "count", JsonValue.Number(decimal refsArr.Length)
                                                   "ok",    JsonValue.Boolean true |]
                                        | None ->
                                            JsonValue.Record
                                                [| "kind", JsonValue.String "none"
                                                   "ok",   JsonValue.Boolean false |]
                                | None ->
                                    JsonValue.Record
                                        [| "ok", JsonValue.Boolean false
                                           "error", JsonValue.String "LSP server not ready" |]
                            Some result

                        // ── cwtools.ai.queryDefinitionByName ──────────────────────────────────────
                        // Find where a named symbol (scripted_trigger, scripted_effect, event, type)
                        // is defined, by searching AllEntities for a top-level key that matches.
                        // Much more practical than position-based GoToType for AI use.
                        //
                        // Optimization: Phase 1 uses g.Types() — an already-indexed Map<typeName, TypeDefInfo[]>
                        // for O(1) lookup. Phase 2 falls back to AllEntities scan only if Types() misses.
                        | { command = "cwtools.ai.queryDefinitionByName"
                            arguments = args } ->
                            // Safely extract symbolName from first arg (handles empty args list)
                            let symbolName =
                                args
                                |> List.tryItem 0
                                |> Option.bind (function
                                    | JsonValue.String s when s.Trim() <> "" -> Some (s.Trim())
                                    | _ -> None)
                            let result =
                                match symbolName with
                                | None ->
                                    JsonValue.Record
                                        [| "ok",    JsonValue.Boolean false
                                           "error", JsonValue.String "symbolName is required. Provide the exact name of the symbol to find, e.g. \"my_scripted_trigger\" or \"distar.001\"." |]
                                | Some name ->
                                    // Phase 1: Fast lookup via Types() index (O(1) per type category)
                                    let tryFindInTypes (g: IGame) =
                                        g.Types()
                                        |> Map.toSeq
                                        |> Seq.tryPick (fun (_typeName, instances) ->
                                            instances
                                            |> Array.tryFind (fun td ->
                                                String.Equals(td.id, name, StringComparison.OrdinalIgnoreCase))
                                            |> Option.map (fun td ->
                                                JsonValue.Record
                                                    [| "name",   JsonValue.String name
                                                       "file",   JsonValue.String (td.range.FileName.Replace('\\', '/'))
                                                       "line",   JsonValue.Number(decimal (int td.range.StartLine))
                                                       "col",    JsonValue.Number(decimal (int td.range.StartColumn))
                                                       "ok",     JsonValue.Boolean true |]))

                                    // Phase 2: Fallback to full AllEntities scan (for non-typed symbols)
                                    let tryFindInGame (g: IGame<'T>) =
                                        g.AllEntities()
                                        |> Seq.tryPick (fun struct (e, _) ->
                                            let node = e.entity
                                            node.Children
                                            |> Seq.tryFind (fun child ->
                                                String.Equals(child.Key, name, StringComparison.OrdinalIgnoreCase))
                                            |> Option.map (fun child ->
                                                JsonValue.Record
                                                    [| "name",   JsonValue.String name
                                                       "file",   JsonValue.String (e.filepath.Replace('\\', '/'))
                                                       "line",   JsonValue.Number(decimal (int child.Position.StartLine))
                                                       "col",    JsonValue.Number(decimal (int child.Position.StartColumn))
                                                       "ok",     JsonValue.Boolean true |]))

                                    // Try Types() first (fast), then AllEntities (slow)
                                    let found =
                                        (gameObj |> Option.bind tryFindInTypes)
                                        |> Option.orElse (stlGameObj    |> Option.bind tryFindInGame)
                                        |> Option.orElse (hoi4GameObj   |> Option.bind tryFindInGame)
                                        |> Option.orElse (eu4GameObj    |> Option.bind tryFindInGame)
                                        |> Option.orElse (ck2GameObj    |> Option.bind tryFindInGame)
                                        |> Option.orElse (irGameObj     |> Option.bind tryFindInGame)
                                        |> Option.orElse (vic2GameObj   |> Option.bind tryFindInGame)
                                        |> Option.orElse (ck3GameObj    |> Option.bind tryFindInGame)
                                        |> Option.orElse (vic3GameObj   |> Option.bind tryFindInGame)
                                        |> Option.orElse (eu5GameObj    |> Option.bind tryFindInGame)
                                        |> Option.orElse (customGameObj |> Option.bind tryFindInGame)
                                    match found with
                                    | Some json -> json
                                    | None ->
                                        match gameObj with
                                        | None ->
                                            JsonValue.Record [| "ok", JsonValue.Boolean false; "error", JsonValue.String "LSP server not ready" |]
                                        | Some _ ->
                                            JsonValue.Record
                                                [| "ok",    JsonValue.Boolean false
                                                   "error", JsonValue.String $"Symbol '{name}' not found. Try query_scripted_effects or query_scripted_triggers with a filter instead." |]
                            Some result

                        // ── cwtools.ai.queryScriptedEffects ───────────────────────────────────────
                        // Returns all scripted effects with name, scope constraints and type
                        | { command = "cwtools.ai.queryScriptedEffects"
                            arguments = rest } ->
                            let filterStr =
                                rest |> List.tryItem 0
                                |> Option.bind (function JsonValue.String s when s <> "" -> Some s | _ -> None)
                            let limitVal =
                                rest |> List.tryItem 1
                                |> Option.bind (function JsonValue.Number n -> Some(int n) | _ -> None)
                                |> Option.defaultValue 200
                            let result =
                                match gameObj with
                                | Some g ->
                                    let effects = g.ScriptedEffects()
                                    // Resolve name once per item via choose (avoids double GetStringForIDs)
                                    let arr =
                                        effects
                                        |> List.choose (fun e ->
                                            let name = CWTools.Utilities.StringResource.stringManager.GetStringForIDs e.Name
                                            match filterStr with
                                            | Some f when not (name.Contains(f, StringComparison.OrdinalIgnoreCase)) -> None
                                            | _ -> Some (name, e))
                                        |> List.truncate limitVal
                                        |> List.map (fun (name, e) ->
                                            let scopes = e.Scopes |> List.map (fun s -> JsonValue.String(s.ToString())) |> Array.ofList
                                            JsonValue.Record
                                                [| "name",   JsonValue.String name
                                                   "scopes", JsonValue.Array scopes
                                                   "type",   JsonValue.String (e.Type.ToString()) |])
                                        |> Array.ofList
                                    JsonValue.Record
                                        [| "effects",    JsonValue.Array arr
                                           "totalCount", JsonValue.Number(decimal (List.length effects))
                                           "ok",         JsonValue.Boolean true |]
                                | None ->
                                    JsonValue.Record [| "ok", JsonValue.Boolean false; "error", JsonValue.String "LSP server not ready" |]
                            Some result

                        // ── cwtools.ai.queryScriptedTriggers ─────────────────────────────────────
                        // Returns all scripted triggers with name, scope constraints and type
                        | { command = "cwtools.ai.queryScriptedTriggers"
                            arguments = rest } ->
                            let filterStr =
                                rest |> List.tryItem 0
                                |> Option.bind (function JsonValue.String s when s <> "" -> Some s | _ -> None)
                            let limitVal =
                                rest |> List.tryItem 1
                                |> Option.bind (function JsonValue.Number n -> Some(int n) | _ -> None)
                                |> Option.defaultValue 200
                            let result =
                                match gameObj with
                                | Some g ->
                                    let triggers = g.ScriptedTriggers()
                                    // Resolve name once per item via choose (avoids double GetStringForIDs)
                                    let arr =
                                        triggers
                                        |> List.choose (fun e ->
                                            let name = CWTools.Utilities.StringResource.stringManager.GetStringForIDs e.Name
                                            match filterStr with
                                            | Some f when not (name.Contains(f, StringComparison.OrdinalIgnoreCase)) -> None
                                            | _ -> Some (name, e))
                                        |> List.truncate limitVal
                                        |> List.map (fun (name, e) ->
                                            let scopes = e.Scopes |> List.map (fun s -> JsonValue.String(s.ToString())) |> Array.ofList
                                            JsonValue.Record
                                                [| "name",   JsonValue.String name
                                                   "scopes", JsonValue.Array scopes
                                                   "type",   JsonValue.String (e.Type.ToString()) |])
                                        |> Array.ofList
                                    JsonValue.Record
                                        [| "triggers",   JsonValue.Array arr
                                           "totalCount", JsonValue.Number(decimal (List.length triggers))
                                           "ok",         JsonValue.Boolean true |]
                                | None ->
                                    JsonValue.Record [| "ok", JsonValue.Boolean false; "error", JsonValue.String "LSP server not ready" |]
                            Some result

                        // ── cwtools.ai.queryEnums ─────────────────────────────────────────────────
                        // Returns enum values from CachedRuleMetadata (available on IGame interface)
                        | { command = "cwtools.ai.queryEnums"
                            arguments = enumNameArg :: rest } ->
                            let enumName = enumNameArg.AsString()
                            let limitVal =
                                rest |> List.tryItem 0
                                |> Option.bind (function JsonValue.Number n -> Some(int n) | _ -> None)
                                |> Option.defaultValue 500
                            let result =
                                match gameObj with
                                | None ->
                                    JsonValue.Record [| "ok", JsonValue.Boolean false; "error", JsonValue.String "LSP server not ready" |]
                                | Some g ->
                                    // GetEmbeddedMetadata() is on the IGame interface
                                    let metadata = g.GetEmbeddedMetadata()
                                    if enumName = "" then
                                        // Return all available enum names
                                        let allNames = metadata.enumDefs |> Map.keys |> Seq.toArray
                                        JsonValue.Record
                                            [| "allEnumNames", JsonValue.Array(allNames |> Array.map JsonValue.String)
                                               "ok",           JsonValue.Boolean true |]
                                    else
                                        match metadata.enumDefs |> Map.tryFind enumName with
                                        | Some (desc, values) ->
                                            let valuesArr =
                                                values
                                                |> Array.truncate limitVal
                                                |> Array.map JsonValue.String
                                            JsonValue.Record
                                                [| "enumName",   JsonValue.String enumName
                                                   "desc",       JsonValue.String desc
                                                   "values",     JsonValue.Array valuesArr
                                                   "totalCount", JsonValue.Number(decimal values.Length)
                                                   "ok",         JsonValue.Boolean true |]
                                        | None ->
                                            JsonValue.Record
                                                [| "ok",       JsonValue.Boolean false
                                                   "enumName", JsonValue.String enumName
                                                   "error",    JsonValue.String $"Enum '{enumName}' not found" |]
                            Some result

                        // ── cwtools.ai.queryStaticModifiers ───────────────────────────────────────
                        // Returns static modifiers filterable by name fragment
                        | { command = "cwtools.ai.queryStaticModifiers"
                            arguments = rest } ->
                            let filterStr =
                                rest |> List.tryItem 0
                                |> Option.bind (function JsonValue.String s when s <> "" -> Some s | _ -> None)
                            let limitVal =
                                rest |> List.tryItem 1
                                |> Option.bind (function JsonValue.Number n -> Some(int n) | _ -> None)
                                |> Option.defaultValue 300
                            let result =
                                match gameObj with
                                | Some g ->
                                    let mods = g.StaticModifiers()
                                    let filtered =
                                        mods
                                        |> Array.filter (fun m ->
                                            match filterStr with
                                            | None   -> true
                                            | Some f -> m.tag.Contains(f, StringComparison.OrdinalIgnoreCase))
                                        |> Array.truncate limitVal
                                    let arr =
                                        filtered
                                        |> Array.map (fun m ->
                                            let cats = m.categories |> List.map (fun c -> JsonValue.String(c.ToString())) |> Array.ofList
                                            JsonValue.Record
                                                [| "tag",        JsonValue.String m.tag
                                                   "categories", JsonValue.Array cats |])
                                    JsonValue.Record
                                        [| "modifiers",  JsonValue.Array arr
                                           "totalCount", JsonValue.Number(decimal mods.Length)
                                           "ok",         JsonValue.Boolean true |]
                                | None ->
                                    JsonValue.Record [| "ok", JsonValue.Boolean false; "error", JsonValue.String "LSP server not ready" |]
                            Some result

                        // ── cwtools.ai.queryVariables ─────────────────────────────────────────────
                        // Returns all scripted @variable = value definitions
                        | { command = "cwtools.ai.queryVariables"
                            arguments = rest } ->
                            let filterStr =
                                rest |> List.tryItem 0
                                |> Option.bind (function JsonValue.String s when s <> "" -> Some s | _ -> None)
                            let result =
                                match gameObj with
                                | Some g ->
                                    let vars = g.ScriptedVariables()
                                    let filtered =
                                        vars
                                        |> List.filter (fun (name, _) ->
                                            match filterStr with
                                            | None   -> true
                                            | Some f -> name.Contains(f, StringComparison.OrdinalIgnoreCase))
                                    let arr =
                                        filtered
                                        |> List.map (fun (name, value) ->
                                            JsonValue.Record
                                                [| "name",  JsonValue.String name
                                                   "value", JsonValue.String value |])
                                        |> Array.ofList
                                    JsonValue.Record
                                        [| "variables",  JsonValue.Array arr
                                           "totalCount", JsonValue.Number(decimal (List.length vars))
                                           "ok",         JsonValue.Boolean true |]
                                | None ->
                                    JsonValue.Record [| "ok", JsonValue.Boolean false; "error", JsonValue.String "LSP server not ready" |]
                            Some result

                        // ── cwtools.ai.getEntityInfo ──────────────────────────────────────────────
                        // BatchFolds: returns type refs, defined vars, effect/trigger blocks, event_targets
                        // Uses ComputedData cache which is available on IGame<T>.AllEntities()
                        | { command = "cwtools.ai.getEntityInfo"
                            arguments = uriArg :: _ } ->
                            let filePath =
                                let raw = uriArg.AsString()
                                getPathFromDoc (Uri(raw))
                            let result =
                                match gameObj with
                                | None ->
                                    JsonValue.Record [| "ok", JsonValue.Boolean false; "error", JsonValue.String "LSP server not ready" |]
                                | Some _g ->
                                    // Helper to find an entity via IGame<T>.AllEntities() and extract pre-computed data
                                    // Uses Dictionary for O(1) lookup instead of O(N) Seq.tryFind
                                    let tryEntityFromGame (g: IGame<'T>) =
                                        g.AllEntities()
                                        |> Seq.tryFind (fun struct (e, _) ->
                                            String.Equals(e.filepath, filePath, StringComparison.OrdinalIgnoreCase))
                                        |> Option.map (fun struct (e, lazyData) ->
                                            let cd = lazyData.Force()

                                            // Serialize referenced types (from ComputedData.Referencedtypes)
                                            let typesArr =
                                                match cd.Referencedtypes with
                                                | None -> [||]
                                                | Some typesMap ->
                                                    typesMap
                                                    |> Map.toSeq
                                                    |> Seq.collect (fun (typeGroup, refList) ->
                                                        refList |> List.map (fun rd ->
                                                            let nameStr = CWTools.Utilities.StringResource.stringManager.GetStringForIDs rd.name
                                                            JsonValue.Record
                                                                [| "typeGroup", JsonValue.String typeGroup
                                                                   "name",      JsonValue.String nameStr |]))
                                                    |> Array.ofSeq

                                            // Serialize defined variables (from ComputedData.Definedvariables)
                                            let varsArr =
                                                match cd.Definedvariables with
                                                | None -> [||]
                                                | Some varMap ->
                                                    varMap
                                                    |> Map.toSeq
                                                    |> Seq.collect (fun (varType, varList) ->
                                                        varList |> Seq.map (fun (name, _rng) ->
                                                            JsonValue.Record
                                                                [| "varType", JsonValue.String varType
                                                                   "name",    JsonValue.String name |]))
                                                    |> Array.ofSeq

                                            // Serialize effect blocks (from ComputedData.EffectBlocks)
                                            let effectsArr =
                                                match cd.EffectBlocks with
                                                | None -> [||]
                                                | Some nodes ->
                                                    nodes
                                                    |> List.map (fun (n: CWTools.Process.Node) ->
                                                        JsonValue.Record
                                                            [| "key",  JsonValue.String n.Key
                                                               "line", JsonValue.Number(decimal (int n.Position.StartLine)) |])
                                                    |> Array.ofList

                                            // Serialize trigger blocks (from ComputedData.TriggerBlocks)
                                            let triggersArr =
                                                match cd.TriggerBlocks with
                                                | None -> [||]
                                                | Some nodes ->
                                                    nodes
                                                    |> List.map (fun (n: CWTools.Process.Node) ->
                                                        JsonValue.Record
                                                            [| "key",  JsonValue.String n.Key
                                                               "line", JsonValue.Number(decimal (int n.Position.StartLine)) |])
                                                    |> Array.ofList

                                            // Serialize saved event targets (from ComputedData.SavedEventTargets)
                                            let eventTargetsArr =
                                                match cd.SavedEventTargets with
                                                | None -> [||]
                                                | Some targets ->
                                                    targets
                                                    |> Seq.map (fun (name, _rng, scope) ->
                                                        JsonValue.Record
                                                            [| "name",  JsonValue.String name
                                                               "scope", JsonValue.String (scope.ToString()) |])
                                                    |> Array.ofSeq

                                            JsonValue.Record
                                                [| "referencedTypes", JsonValue.Array typesArr
                                                   "definedVars",     JsonValue.Array varsArr
                                                   "effectBlocks",    JsonValue.Array effectsArr
                                                   "triggerBlocks",   JsonValue.Array triggersArr
                                                   "eventTargets",    JsonValue.Array eventTargetsArr
                                                   "file",            JsonValue.String (filePath.Replace('\\', '/'))
                                                   "ok",              JsonValue.Boolean true |])

                                    let entityResult =
                                        stlGameObj  |> Option.bind tryEntityFromGame
                                        |> Option.orElse (hoi4GameObj  |> Option.bind tryEntityFromGame)
                                        |> Option.orElse (eu4GameObj   |> Option.bind tryEntityFromGame)
                                        |> Option.orElse (ck2GameObj   |> Option.bind tryEntityFromGame)
                                        |> Option.orElse (irGameObj    |> Option.bind tryEntityFromGame)
                                        |> Option.orElse (vic2GameObj  |> Option.bind tryEntityFromGame)
                                        |> Option.orElse (ck3GameObj   |> Option.bind tryEntityFromGame)
                                        |> Option.orElse (vic3GameObj  |> Option.bind tryEntityFromGame)
                                        |> Option.orElse (eu5GameObj   |> Option.bind tryEntityFromGame)
                                        |> Option.orElse (customGameObj|> Option.bind tryEntityFromGame)

                                    match entityResult with
                                    | Some json -> json
                                    | None ->
                                        JsonValue.Record
                                            [| "ok",    JsonValue.Boolean false
                                               "error", JsonValue.String $"No entity found for file: {filePath}" |]
                            Some result

                        // M8 Fix: previously these were declared as isReadCmd=true in LanguageServer.fs
                        // but had no implementation — they would silently return null.
                        // Return a structured not-implemented response so callers can detect the gap.
                        | { command = "typeGraphInfo"; arguments = _ }
                        | { command = "getFileTypes"; arguments = _ }
                        | { command = "getDataForFile"; arguments = _ }
                        | { command = "getTypesForFile"; arguments = _ } ->
                            Some(
                                JsonValue.Record
                                    [| "ok",    JsonValue.Boolean false
                                       "error", JsonValue.String "Command is declared but not implemented on the server" |])

                        | _ -> None

                    | None -> None
            }
            |> catchError None


[<EntryPoint>]
let main (_: array<string>) : int =
    Encoding.RegisterProvider(CodePagesEncodingProvider.Instance)
    LangResources.Culture <- System.Globalization.CultureInfo.CurrentCulture
    let cultureInfo = System.Globalization.CultureInfo("en-US")
    System.Globalization.CultureInfo.DefaultThreadCurrentCulture <- cultureInfo
    System.Globalization.CultureInfo.DefaultThreadCurrentUICulture <- cultureInfo
    System.Threading.Thread.CurrentThread.CurrentCulture <- cultureInfo
    System.Threading.Thread.CurrentThread.CurrentUICulture <- cultureInfo
    // CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
    let read = new BinaryReader(Console.OpenStandardInput())
    let write = new BinaryWriter(Console.OpenStandardOutput())
    let serverFactory client = Server(client) :> ILanguageServer
    // "Listening on stdin"
    try
        LanguageServer.connect (serverFactory, read, write)
        0 // return an integer exit code
    with e ->
        Log.dprintfn $"Exception in language server {e}"
        1
//eprintfn "%A" (JsonValue.Parse "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"processId\":12660,\"rootUri\": \"file:///c%3A/Users/Thomas/Documents/Paradox%20Interactive/Stellaris\"},\"capabilities\":{\"workspace\":{}}}")
//0
