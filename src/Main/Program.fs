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
open CWTools.Localisation
open LSP.LanguageServer   // brings gameStateLock into scope

// Precompile regular to avoid InlayHint / precache allocation every time on the hot path
let private inlayLocalVarPattern =
    System.Text.RegularExpressions.Regex(
        @"^\s*(@[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n\r#]+)",
        System.Text.RegularExpressions.RegexOptions.Multiline ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private paradoxColorPattern =
    System.Text.RegularExpressions.Regex(
        @"§[RGBYWHETLMSP!]",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private scriptedParamRegex =
    System.Text.RegularExpressions.Regex(
        @"\$([A-Za-z_][A-Za-z0-9_]*)\$",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private codeLensDefinitionKeyPattern =
    System.Text.RegularExpressions.Regex(
        @"^\s*(""?[A-Za-z0-9_.$:@-]+""?)\s*=",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private codeLensNameFieldPattern =
    System.Text.RegularExpressions.Regex(
        @"(?:^|[\s{])\b(name|id|key)\b\s*=\s*(""?[A-Za-z0-9_.$:@-]+""?)",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private isLocalisationDefinitionPath (filePath: string) =
    let normalized = filePath.Replace('\\', '/').ToLowerInvariant()
    normalized.EndsWith(".yml")
    || normalized.Contains("/localisation/")
    || normalized.Contains("/localisation_synced/")
    || normalized.Contains("/localization/")

let private isNavigableDefinitionRange (r: range) =
    not (String.IsNullOrWhiteSpace r.FileName)

let private tryFindDescriptorRoot (filePath: string) =
    let rec loop (dir: DirectoryInfo) =
        if isNull dir then None
        elif File.Exists(Path.Combine(dir.FullName, "descriptor.mod")) then Some dir.FullName
        else loop dir.Parent

    try
        let start =
            let attr = File.GetAttributes(filePath)
            if attr.HasFlag(FileAttributes.Directory) then DirectoryInfo(filePath)
            else FileInfo(filePath).Directory
        if isNull start then None else loop start
    with _ -> None

let private tryFindContentRoot (filePath: string) =
    let contentDirs =
        set
            [ "common"; "events"; "interface"; "gfx"; "localisation"; "localisation_synced"
              "localization"; "map"; "history"; "prescripted_countries"; "sound"; "music" ]

    let rec loop (dir: DirectoryInfo) =
        if isNull dir then None
        elif contentDirs.Contains(dir.Name.ToLowerInvariant()) && not (isNull dir.Parent) then
            Some dir.Parent.FullName
        else loop dir.Parent

    try
        let start =
            let attr = File.GetAttributes(filePath)
            if attr.HasFlag(FileAttributes.Directory) then DirectoryInfo(filePath)
            else FileInfo(filePath).Directory
        if isNull start then None else loop start
    with _ -> None

let private tryFindProjectRoot filePath =
    tryFindDescriptorRoot filePath
    |> Option.orElseWith (fun () -> tryFindContentRoot filePath)

let private isAllowedDefinitionTarget (sourcePath: string) (targetPath: string) =
    match tryFindProjectRoot sourcePath, tryFindProjectRoot targetPath with
    | Some sourceRoot, Some targetRoot ->
        String.Equals(sourceRoot, targetRoot, StringComparison.OrdinalIgnoreCase)
    | _ -> true

let private normalizeDefinitionSymbol (symbol: string) =
    symbol.Trim().Trim('"')

let private tryDefinitionSymbolAt (sourceText: string) (line: int) (character: int) =
    if String.IsNullOrEmpty sourceText then None
    else
        let lines = sourceText.Split('\n')
        if line < 0 || line >= lines.Length then None
        else
            let lineText = lines.[line].TrimEnd('\r')
            if String.IsNullOrEmpty lineText then None
            else
                let isSymbolChar c =
                    Char.IsLetterOrDigit c
                    || c = '_'
                    || c = '.'
                    || c = ':'
                    || c = '@'
                    || c = '-'
                    || c = '/'

                let initial = min (max 0 character) (lineText.Length - 1)
                let cursor =
                    if isSymbolChar lineText.[initial] then initial
                    elif initial > 0 && isSymbolChar lineText.[initial - 1] then initial - 1
                    else initial

                if not (isSymbolChar lineText.[cursor]) then None
                else
                    let mutable startIndex = cursor
                    while startIndex > 0 && isSymbolChar lineText.[startIndex - 1] do
                        startIndex <- startIndex - 1

                    let mutable endIndex = cursor
                    while endIndex + 1 < lineText.Length && isSymbolChar lineText.[endIndex + 1] do
                        endIndex <- endIndex + 1

                    let symbol = lineText.Substring(startIndex, endIndex - startIndex + 1) |> normalizeDefinitionSymbol
                    if String.IsNullOrWhiteSpace symbol then None else Some symbol

let private tryCodeDefinitionBySymbol
    (gameDispatcher: IGameDispatcher)
    (game: IGame)
    (sourcePath: string)
    (symbol: string)
    =
    let needle = normalizeDefinitionSymbol symbol
    let sameSymbol value =
        String.Equals(normalizeDefinitionSymbol value, needle, StringComparison.OrdinalIgnoreCase)
    let isCodeRange (r: range) =
        isNavigableDefinitionRange r
        && not (isLocalisationDefinitionPath r.FileName)
        && isAllowedDefinitionTarget sourcePath r.FileName

    let isGfxDefinitionNodeKey key =
        match key with
        | "spriteType"
        | "corneredTileSpriteType"
        | "frameAnimatedSpriteType"
        | "textSpriteType"
        | "maskedShieldTexture"
        | "progressBarType"
        | "tileSpriteType" -> true
        | _ -> false

    if String.IsNullOrWhiteSpace needle then None
    else
        let typeMap = game.Types()
        let fromTypes =
            typeMap
            |> Map.toSeq
            |> Seq.tryPick (fun (_, infos) ->
                infos
                |> Array.tryPick (fun tdi ->
                    if isCodeRange tdi.range && sameSymbol tdi.id then Some tdi.range else None))

        let fromGfxSpriteNames () =
            let visitor =
                { new IGameVisitor<_> with
                    member _.Visit game =
                        let rec findSpriteName (node: CWTools.Process.Node) =
                            let current =
                                if isGfxDefinitionNodeKey node.Key && sameSymbol (node.TagText "name") then
                                    Some node.Position
                                else None

                            current
                            |> Option.orElseWith (fun () ->
                                node.Children
                                |> Seq.tryPick findSpriteName)

                        game.AllEntities()
                        |> Seq.tryPick (fun struct (entity, _) ->
                            let targetPath = entity.filepath
                            if isLocalisationDefinitionPath targetPath
                               || not (isAllowedDefinitionTarget sourcePath targetPath)
                               || not (targetPath.EndsWith(".gfx", StringComparison.OrdinalIgnoreCase)
                                       || targetPath.EndsWith(".asset", StringComparison.OrdinalIgnoreCase)) then
                                None
                            else findSpriteName entity.entity) }

            gameDispatcher.Dispatch visitor |> Option.flatten

        // Only attempt the expensive AllEntities() scan for GFX-prefixed symbols.
        // Non-GFX identifiers (loc keys, effects, triggers, etc.) will never match
        // a spriteType node, so the full entity walk is wasted work.
        if needle.StartsWith("GFX_", StringComparison.OrdinalIgnoreCase) then
            fromTypes |> Option.orElseWith fromGfxSpriteNames
        else
            fromTypes

let private preferCodeDefinitionOverLocalisation
    (gameDispatcher: IGameDispatcher)
    (game: IGame)
    (sourcePath: string)
    (sourceText: string)
    (line: int)
    (character: int)
    (candidate: range option)
    =
    match candidate with
    | Some target when not (isNavigableDefinitionRange target) ->
        tryDefinitionSymbolAt sourceText line character
        |> Option.bind (tryCodeDefinitionBySymbol gameDispatcher game sourcePath)
    | Some target when isLocalisationDefinitionPath target.FileName ->
        // GoToType already resolved to a loc file - return it directly.
        candidate
    | _ -> candidate |> Option.filter isNavigableDefinitionRange

[<assembly: AssemblyDescription("CWTools language server for PDXScript")>]
do ()

let mutable diagnosticLogging = false

type MonitorLogKind =
    | Memory
    | Cache
    | Performance
    | Lint
    | Refresh
    | Localisation
    | Completion
    | Hover
    | Lifecycle

let private monitorLogKindName =
    function
    | Memory -> "Memory"
    | Cache -> "Cache"
    | Performance -> "Performance"
    | Lint -> "Lint"
    | Refresh -> "Refresh"
    | Localisation -> "Localisation"
    | Completion -> "Completion"
    | Hover -> "Hover"
    | Lifecycle -> "Lifecycle"

let mutable private monitorLogSink: string -> string -> unit = fun _ _ -> ()

let private monitorLog kind message =
    monitorLogSink (monitorLogKindName kind) message

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

    let logMonitor =
        (fun category message ->
            try
                client.CustomNotification(
                    "monitorLog",
                    JsonValue.Record
                        [| "category", JsonValue.String category
                           "message", JsonValue.String message
                           "timestamp", JsonValue.String(System.DateTime.Now.ToString("HH:mm:ss")) |]
                )
            with _ -> ())

    CWTools.Utilities.Utils.logInfo <- logInfo
    CWTools.Utilities.Utils.logWarning <- logWarning
    CWTools.Utilities.Utils.logError <- logError
    CWTools.Utilities.Utils.logDiag <- logDiag
    monitorLogSink <- logMonitor

type LintRequestMsg =
    | UpdateRequest of VersionedTextDocumentIdentifier * bool
    /// DidOpen/DidFocus: deep lint without marking needsTypeRefresh.
    /// Opening a file does not change its content, so the type index stays valid.
    | OpenRequest of VersionedTextDocumentIdentifier
    | WorkComplete of DateTime

/// Shared token computation - walks AST, classifies tokens, encodes to delta int[].
let computeShaderTokens (game: IGame<_>) (filePath: string) (fileText: string) =
    let tokens = ResizeArray<struct (int * int * int * int * int)>()
    let lines: string[] = fileText.Split('\n')
    
    let sources = CWTools.Games.PdxShaderFeatures.getShaderSources (game.AllFiles()) filePath fileText
    
    let globalVariables = System.Collections.Generic.HashSet<string>(CWTools.Games.PdxShaderFeatures.builtinVariablesSet.Value)
    let globalFunctions = System.Collections.Generic.HashSet<string>(CWTools.Games.PdxShaderFeatures.builtinFunctionsSet.Value)
    
    let parsedGlobals = CWTools.Games.PdxShaderFeatures.parseGlobalVariables sources
    for v in parsedGlobals do
        globalVariables.Add(v) |> ignore
        
    let parsedFuncs = CWTools.Games.PdxShaderFeatures.parseGlobalFunctions sources
    for f: CWTools.Games.CompletionResponse in parsedFuncs do
        match f with
        | CWTools.Games.CompletionResponse.Snippet(label, _, _, _, _) -> globalFunctions.Add(label) |> ignore
        | CWTools.Games.CompletionResponse.Simple(label, _, _) -> globalFunctions.Add(label) |> ignore
        | CWTools.Games.CompletionResponse.Detailed(label, _, _, _) -> globalFunctions.Add(label) |> ignore
        
    let wordRegex = System.Text.RegularExpressions.Regex(@"\b([A-Za-z_][A-Za-z0-9_]*)\b", System.Text.RegularExpressions.RegexOptions.Compiled)
    
    let verifyAndAdd (line: int) (col: int) (len: int) (tokenType: int) =
        if line >= 0 && line < lines.Length then
            let srcLine = lines.[line]
            if col >= 0 && col + len <= srcLine.Length then
                tokens.Add(struct (line, col, len, tokenType, 0))
                
    let getInsideStringIntervals (lineText: string) (limit: int) =
        let stringIntervals = ResizeArray<int * int>()
        let mutable inString = false
        let mutable strStart = -1
        let mutable i = 0
        while i < limit do
            if lineText.[i] = '"' && (i = 0 || lineText.[i - 1] <> '\\') then
                if inString then
                    stringIntervals.Add((strStart, i))
                    inString <- false
                else
                    strStart <- i
                    inString <- true
            i <- i + 1
        stringIntervals

    let isInsideIntervals (intervals: ResizeArray<int * int>) (col: int) (len: int) =
        let mutable found = false
        let mutable idx = 0
        while idx < intervals.Count && not found do
            let sStart, sEnd = intervals.[idx]
            if col >= sStart && (col + len - 1) <= sEnd then
                found <- true
            idx <- idx + 1
        found
                
    lines |> Array.iteri (fun lineIdx (lineText: string) ->
        let commentIdx = lineText.IndexOf("//")
        let limit = if commentIdx >= 0 then commentIdx else lineText.Length
        if commentIdx >= 0 then
            verifyAndAdd lineIdx commentIdx (lineText.Length - commentIdx) 10
            
        let intervals = getInsideStringIntervals lineText limit
        let subText = lineText.Substring(0, limit)
        let matches = wordRegex.Matches(subText)
        for i = 0 to matches.Count - 1 do
            let m = matches.[i]
            if m.Success && m.Groups.Count >= 2 then
                let word = m.Groups.[1].Value
                let col = m.Index
                let len = word.Length
                if not (isInsideIntervals intervals col len) then
                    if globalVariables.Contains(word) then
                        verifyAndAdd lineIdx col len 3
                    elif globalFunctions.Contains(word) then
                        verifyAndAdd lineIdx col len 2
    )
    
    let sorted = tokens |> Seq.toArray |> Array.sortBy (fun struct (l, c, _, _, _) -> l, c)
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
    data |> Seq.toArray

let computeScriptTokens (game: IGame<_>) (filePath: string) (fileText: string) =
    let entityOpt =
        game.AllEntities()
        |> Seq.tryPick (fun struct (e, _) ->
            if e.filepath = filePath then Some e else None)
    match entityOpt with
    | None -> [||]
    | Some entity ->
        let tokens = ResizeArray<struct (int * int * int * int * int)>()
        let lines = fileText.Split('\n')
        let allEffects = game.ScriptedEffects() |> Seq.map (fun e -> e.Name.GetString()) |> System.Collections.Generic.HashSet
        let allTriggers = game.ScriptedTriggers() |> Seq.map (fun e -> e.Name.GetString()) |> System.Collections.Generic.HashSet
        let keywords = System.Collections.Generic.HashSet([|
            "if"; "else"; "else_if"; "AND"; "OR"; "NOT"; "NOR"; "NAND"
            "limit"; "trigger"; "modifier"; "while"
            "switch"; "every"; "random"; "random_list"; "inline_script"
        |])
        let verifyAndAdd (line: int) (col: int) (len: int) (tokenType: int) =
            if line >= 0 && line < lines.Length then
                let srcLine = lines.[line]
                if col >= 0 && col + len <= srcLine.Length then
                    tokens.Add(struct (line, col, len, tokenType, 0))
        let tryIndexOfFrom (srcLine: string) (value: string) (startIndex: int) =
            let safeStart = max 0 startIndex
            if safeStart <= srcLine.Length then
                srcLine.IndexOf(value, safeStart)
            else
                -1
        let rec visitNode (n: CWTools.Process.Node) =
            n.Leaves |> Seq.iter (fun l ->
                if l.Position.FileName = filePath then
                    let line = max 0 (int l.Position.StartLine - 1)
                    let col = int l.Position.StartColumn
                    let key = l.Key
                    let rawVal = l.Value.ToRawString()
                    if key.Length > 0 && line < lines.Length then
                        let srcLine = lines.[line]
                        let actualCol =
                            if col >= 0 && col + key.Length <= srcLine.Length && srcLine.Substring(col, key.Length) = key then col
                            else let idx = tryIndexOfFrom srcLine key col
                                 if idx >= 0 then idx
                                 else let idx2 = srcLine.IndexOf(key)
                                      if idx2 >= 0 then idx2 else -1
                        if actualCol >= 0 then
                            let keyType =
                                if key.StartsWith("@") then 3
                                elif key.StartsWith("$") && key.EndsWith("$") then 4
                                elif allEffects.Contains(key) then 2
                                elif allTriggers.Contains(key) then 1
                                elif keywords.Contains(key) then 7
                                else 5
                            verifyAndAdd line actualCol key.Length keyType
                    let valLine = max 0 (int l.Position.EndLine - 1)
                    if valLine < lines.Length && rawVal.Length > 0 then
                        let cleanVal = rawVal.Trim('"')
                        let srcLine = lines.[valLine]
                        let mutable dummy = 0.0
                        let valType =
                            if rawVal.StartsWith("@") then 3
                            elif rawVal.StartsWith("$") && rawVal.EndsWith("$") then 4
                            elif rawVal = "yes" || rawVal = "no" then 7
                            elif System.Double.TryParse(rawVal, &dummy) then 8
                            else 6
                        let searchVal = if rawVal.StartsWith("\"") then cleanVal else rawVal
                        if searchVal.Length > 0 then
                            let endCol = int l.Position.EndColumn
                            let valStartHint = max 0 (endCol - searchVal.Length)
                            let actualValCol =
                                if valStartHint >= 0 && valStartHint + searchVal.Length <= srcLine.Length && srcLine.Substring(valStartHint, searchVal.Length) = searchVal then
                                    valStartHint
                                else
                                    let searchFrom = max 0 (col + key.Length)
                                    let idx = tryIndexOfFrom srcLine searchVal searchFrom
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
            n.Nodes |> Seq.iter (fun childNode ->
                if childNode.Position.FileName = filePath then
                    let nLine = max 0 (int childNode.Position.StartLine - 1)
                    let nCol = int childNode.Position.StartColumn
                    let nKey = childNode.Key
                    if nKey.Length > 0 && nLine < lines.Length then
                        let srcLine = lines.[nLine]
                        let actualCol =
                            if nCol >= 0 && nCol + nKey.Length <= srcLine.Length && srcLine.Substring(nCol, nKey.Length) = nKey then nCol
                            else let idx = tryIndexOfFrom srcLine nKey nCol
                                 if idx >= 0 then idx
                                 else let idx2 = srcLine.IndexOf(nKey)
                                      if idx2 >= 0 then idx2 else -1
                        if actualCol >= 0 then
                            let keyType =
                                if nKey.StartsWith("@") then 3
                                elif nKey.StartsWith("$") && nKey.EndsWith("$") then 4
                                elif allEffects.Contains(nKey) then 2
                                elif allTriggers.Contains(nKey) then 1
                                elif keywords.Contains(nKey) then 7
                                else 5
                            verifyAndAdd nLine actualCol nKey.Length keyType
                visitNode childNode
            )
        visitNode entity.entity
        lines |> Array.iteri (fun lineIdx lineText ->
            let trimmed = lineText.TrimStart()
            if trimmed.StartsWith("#") then
                let col = lineText.Length - trimmed.Length
                tokens.Add(struct (lineIdx, col, lineText.Length - col, 10, 0))
        )
        let sorted = tokens |> Seq.toArray |> Array.sortBy (fun struct (l, c, _, _, _) -> l, c)
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
        data |> Seq.toArray

let computeTokensForFile (game: IGame<_>) (filePath: string) (fileText: string) =
    let isShaderFile (path: string) =
        let ext = System.IO.Path.GetExtension(path)
        ext.Equals(".shader", System.StringComparison.OrdinalIgnoreCase) || ext.Equals(".fxh", System.StringComparison.OrdinalIgnoreCase)
        
    if isShaderFile filePath then
        computeShaderTokens game filePath fileText
    else
        computeScriptTokens game filePath fileText


//-Diagnostic freshness state machine-
// After AI writes the file, it uses epoch + freshness to determine whether the current diagnosis corresponds to the latest file version
type DiagnosticFreshness =
    | Fresh      // Grammar + rules + global verification are completed
    | Pending    // Single file verification completed, global verification (types/localisation) is still queued
    | Stale      // No verification has been run on this version yet

type FileDiagnosticState =
    { version: int option             // Document version (from DidChange)
      validatedVersion: int option    // Document version that produced these diagnostics
      epoch: int64                     // Increment the counter, lint +1 each time
      updatedAtUnixMs: int64           //Unix millisecond timestamp
      freshness: DiagnosticFreshness   // current status
      pendingGlobalKinds: string list  // For example ["localisation"; "types"]
      errorCount: int                  //Lightweight counting, does not store the complete Diagnostic list
      diagnostics: Diagnostic list
      warningCount: int }

type ValidationRuntimeState =
    { inProgress: bool
      inProgressFile: string
      queueDepth: int
      debounceQueueDepth: int
      lastStartedAtUnixMs: int64
      lastCompletedAtUnixMs: int64
      lastCycleElapsedMs: int64
      lastCycleFile: string
      lastCycleShallow: bool
      lastCycleEditAction: bool
      lastAnalyzeElapsedMs: int64
      lastAnalyzeCompletedAtUnixMs: int64
      lastAnalyzeDidGlobalWork: bool
      lastRefreshStatus: string
      lastError: string option }

type LoadingRuntimeState =
    { inProgress: bool
      phase: string
      lastStartedAtUnixMs: int64
      lastCompletedAtUnixMs: int64
      lastElapsedMs: int64
      lastWorkspaceRoot: string
      lastGame: string
      lastFileCount: int
      lastParserErrorCount: int
      lastValidationErrorCount: int
      lastLocalisationErrorCount: int
      lastRulesStatus: string
      lastCacheStatus: string
      lastPrecacheFileCount: int
      lastError: string option }

type CompletionRuntimeState =
    { totalRequests: int
      cacheHits: int
      cacheMisses: int
      lastStartedAtUnixMs: int64
      lastCompletedAtUnixMs: int64
      lastElapsedMs: int64
      lastFile: string
      lastLine: int
      lastCharacter: int
      lastItemCount: int
      lastCacheHit: bool
      lastIsIncomplete: bool
      lastError: string option }

type Server(client: ILanguageClient) =
    do setupLogger client
    let docs = DocumentStore()

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

    //-Diagnostic freshness status table-
    /// Global diagnostic epoch: incremented each time lint is completed, used by the client to determine whether the diagnosis has been updated
    let diagnosticEpoch = ref 0L
    /// Per-file diagnostic metadata (freshness/epoch/counts), maintained by lint and delayedAnalyze
    let fileDiagnosticStates =
        System.Collections.Concurrent.ConcurrentDictionary<string, FileDiagnosticState>()

    let runtimeStateLock = obj()
    let mutable validationRuntimeState =
        { inProgress = false
          inProgressFile = ""
          queueDepth = 0
          debounceQueueDepth = 0
          lastStartedAtUnixMs = 0L
          lastCompletedAtUnixMs = 0L
          lastCycleElapsedMs = 0L
          lastCycleFile = ""
          lastCycleShallow = false
          lastCycleEditAction = false
          lastAnalyzeElapsedMs = 0L
          lastAnalyzeCompletedAtUnixMs = 0L
          lastAnalyzeDidGlobalWork = false
          lastRefreshStatus = "not_started"
          lastError = None }

    let loadingStateLock = obj()
    let mutable loadingRuntimeState =
        { inProgress = false
          phase = "not_started"
          lastStartedAtUnixMs = 0L
          lastCompletedAtUnixMs = 0L
          lastElapsedMs = 0L
          lastWorkspaceRoot = ""
          lastGame = activeGame.ToString()
          lastFileCount = 0
          lastParserErrorCount = 0
          lastValidationErrorCount = 0
          lastLocalisationErrorCount = 0
          lastRulesStatus = "not_started"
          lastCacheStatus = "not_started"
          lastPrecacheFileCount = 0
          lastError = None }

    let completionRuntimeLock = obj()
    let mutable completionRuntimeState =
        { totalRequests = 0
          cacheHits = 0
          cacheMisses = 0
          lastStartedAtUnixMs = 0L
          lastCompletedAtUnixMs = 0L
          lastElapsedMs = 0L
          lastFile = ""
          lastLine = 0
          lastCharacter = 0
          lastItemCount = 0
          lastCacheHit = false
          lastIsIncomplete = false
          lastError = None }

    let nowUnixMs () = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()

    let dateTimeToUnixMs (value: DateTime) =
        if value = DateTime.MinValue then 0L
        else DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc)).ToUnixTimeMilliseconds()

    let updateValidationRuntime update =
        lock runtimeStateLock (fun () ->
            validationRuntimeState <- update validationRuntimeState)

    let validationRuntimeSnapshot () =
        lock runtimeStateLock (fun () -> validationRuntimeState)

    let updateLoadingRuntime update =
        lock loadingStateLock (fun () ->
            loadingRuntimeState <- update loadingRuntimeState)

    let loadingRuntimeSnapshot () =
        lock loadingStateLock (fun () -> loadingRuntimeState)

    let updateCompletionRuntime update =
        lock completionRuntimeLock (fun () ->
            completionRuntimeState <- update completionRuntimeState)

    let completionRuntimeSnapshot () =
        lock completionRuntimeLock (fun () -> completionRuntimeState)

    //-PerfCounters performance observation-
    //Lightweight indicator aggregation, periodically output to log, used for long session performance analysis
    let mutable perfLintCount = 0
    let mutable perfRefreshCachesCount = 0
    let mutable perfRefreshLocCount = 0
    let mutable perfCompletionCount = 0
    let mutable perfLastReportTime = DateTime.UtcNow
    let perfReportIntervalSeconds = 30.0
    let mutable getPerfCacheSnapshot: unit -> string = fun () -> ""
    let mutable getPerfDiagnosticSnapshot: unit -> string = fun () -> ""

    let getPerfMemorySnapshot () =
        use proc = Process.GetCurrentProcess()
        let gcInfo = GC.GetGCMemoryInfo()
        let heapMB = GC.GetTotalMemory(false) / 1048576L
        let allocMB = GC.GetTotalAllocatedBytes(false) / 1048576L
        let workingSetMB = proc.WorkingSet64 / 1048576L
        let privateMB = proc.PrivateMemorySize64 / 1048576L
        let fragmentedMB = gcInfo.FragmentedBytes / 1048576L
        $"mem[heap={heapMB}MB alloc={allocMB}MB working={workingSetMB}MB private={privateMB}MB fragmented={fragmentedMB}MB gc0={GC.CollectionCount(0)} gc1={GC.CollectionCount(1)} gc2={GC.CollectionCount(2)}]"

    let getMemorySnapshotJson () =
        use proc = Process.GetCurrentProcess()
        let gcInfo = GC.GetGCMemoryInfo()
        JsonValue.Record
            [| "heapMB", JsonValue.Number(decimal (GC.GetTotalMemory(false) / 1048576L))
               "allocatedMB", JsonValue.Number(decimal (GC.GetTotalAllocatedBytes(false) / 1048576L))
               "workingSetMB", JsonValue.Number(decimal (proc.WorkingSet64 / 1048576L))
               "privateMB", JsonValue.Number(decimal (proc.PrivateMemorySize64 / 1048576L))
               "fragmentedMB", JsonValue.Number(decimal (gcInfo.FragmentedBytes / 1048576L))
               "gc0", JsonValue.Number(decimal (GC.CollectionCount(0)))
               "gc1", JsonValue.Number(decimal (GC.CollectionCount(1)))
               "gc2", JsonValue.Number(decimal (GC.CollectionCount(2))) |]

    let getDiagnosticSnapshot () =
        let mutable freshFiles = 0
        let mutable pendingFiles = 0
        let mutable staleFiles = 0
        let mutable errors = 0
        let mutable warnings = 0
        for state in fileDiagnosticStates.Values do
            match state.freshness with
            | Fresh -> freshFiles <- freshFiles + 1
            | Pending -> pendingFiles <- pendingFiles + 1
            | Stale -> staleFiles <- staleFiles + 1
            errors <- errors + state.errorCount
            warnings <- warnings + state.warningCount
        $" diag[files={fileDiagnosticStates.Count} fresh={freshFiles} pending={pendingFiles} stale={staleFiles} errors={errors} warnings={warnings}]"

    let getDiagnosticSummaryJson () =
        let mutable freshFiles = 0
        let mutable pendingFiles = 0
        let mutable staleFiles = 0
        let mutable errors = 0
        let mutable warnings = 0
        for state in fileDiagnosticStates.Values do
            match state.freshness with
            | Fresh -> freshFiles <- freshFiles + 1
            | Pending -> pendingFiles <- pendingFiles + 1
            | Stale -> staleFiles <- staleFiles + 1
            errors <- errors + state.errorCount
            warnings <- warnings + state.warningCount
        JsonValue.Record
            [| "files", JsonValue.Number(decimal fileDiagnosticStates.Count)
               "freshFiles", JsonValue.Number(decimal freshFiles)
               "pendingFiles", JsonValue.Number(decimal pendingFiles)
               "staleFiles", JsonValue.Number(decimal staleFiles)
               "errors", JsonValue.Number(decimal errors)
               "warnings", JsonValue.Number(decimal warnings) |]

    let getRuntimeSnapshotJson () =
        let state = validationRuntimeSnapshot ()
        JsonValue.Record
            [| "inProgress", JsonValue.Boolean state.inProgress
               "inProgressFile", JsonValue.String state.inProgressFile
               "queueDepth", JsonValue.Number(decimal state.queueDepth)
               "debounceQueueDepth", JsonValue.Number(decimal state.debounceQueueDepth)
               "lastStartedAtUnixMs", JsonValue.Number(decimal state.lastStartedAtUnixMs)
               "lastCompletedAtUnixMs", JsonValue.Number(decimal state.lastCompletedAtUnixMs)
               "lastCycleElapsedMs", JsonValue.Number(decimal state.lastCycleElapsedMs)
               "lastCycleFile", JsonValue.String state.lastCycleFile
               "lastCycleShallow", JsonValue.Boolean state.lastCycleShallow
               "lastCycleEditAction", JsonValue.Boolean state.lastCycleEditAction
               "lastAnalyzeElapsedMs", JsonValue.Number(decimal state.lastAnalyzeElapsedMs)
               "lastAnalyzeCompletedAtUnixMs", JsonValue.Number(decimal state.lastAnalyzeCompletedAtUnixMs)
               "lastAnalyzeDidGlobalWork", JsonValue.Boolean state.lastAnalyzeDidGlobalWork
               "lastRefreshStatus", JsonValue.String state.lastRefreshStatus
               "lastError",
                    (match state.lastError with
                     | Some error -> JsonValue.String error
                     | None -> JsonValue.Null) |]

    let getLoadingSnapshotJson () =
        let state = loadingRuntimeSnapshot ()
        JsonValue.Record
            [| "inProgress", JsonValue.Boolean state.inProgress
               "phase", JsonValue.String state.phase
               "lastStartedAtUnixMs", JsonValue.Number(decimal state.lastStartedAtUnixMs)
               "lastCompletedAtUnixMs", JsonValue.Number(decimal state.lastCompletedAtUnixMs)
               "lastElapsedMs", JsonValue.Number(decimal state.lastElapsedMs)
               "lastWorkspaceRoot", JsonValue.String state.lastWorkspaceRoot
               "lastGame", JsonValue.String state.lastGame
               "lastFileCount", JsonValue.Number(decimal state.lastFileCount)
               "lastParserErrorCount", JsonValue.Number(decimal state.lastParserErrorCount)
               "lastValidationErrorCount", JsonValue.Number(decimal state.lastValidationErrorCount)
               "lastLocalisationErrorCount", JsonValue.Number(decimal state.lastLocalisationErrorCount)
               "lastRulesStatus", JsonValue.String state.lastRulesStatus
               "lastCacheStatus", JsonValue.String state.lastCacheStatus
               "lastPrecacheFileCount", JsonValue.Number(decimal state.lastPrecacheFileCount)
               "lastError",
                    (match state.lastError with
                     | Some error -> JsonValue.String error
                     | None -> JsonValue.Null) |]

    do getPerfDiagnosticSnapshot <- getDiagnosticSnapshot

    /// Check whether the performance summary log needs to be output after each operation
    let maybePerfReport (operationName: string) =
        let now = DateTime.UtcNow
        let totalOps = perfLintCount + perfRefreshCachesCount + perfRefreshLocCount + perfCompletionCount
        if (now - perfLastReportTime).TotalSeconds >= perfReportIntervalSeconds || totalOps % 100 = 0 then
            let sm = CWTools.Utilities.StringResource.stringManager
            monitorLog Performance $"PerfCounters last={operationName} lint={perfLintCount} refresh={perfRefreshCachesCount} refreshLoc={perfRefreshLocCount} completion={perfCompletionCount} strings={sm.StringCount} ints={sm.IntCount} {getPerfMemorySnapshot()}{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"
            perfLastReportTime <- now

    let gameDispatcher =
        { new IGameDispatcher with
            member _.Dispatch visitor =
                match stlGameObj, hoi4GameObj, eu4GameObj, ck2GameObj, irGameObj, vic2GameObj, ck3GameObj, vic3GameObj, eu5GameObj, customGameObj with
                | Some game, _, _, _, _, _, _, _, _, _ -> Some(visitor.Visit game)
                | _, Some game, _, _, _, _, _, _, _, _ -> Some(visitor.Visit game)
                | _, _, Some game, _, _, _, _, _, _, _ -> Some(visitor.Visit game)
                | _, _, _, Some game, _, _, _, _, _, _ -> Some(visitor.Visit game)
                | _, _, _, _, Some game, _, _, _, _, _ -> Some(visitor.Visit game)
                | _, _, _, _, _, Some game, _, _, _, _ -> Some(visitor.Visit game)
                | _, _, _, _, _, _, Some game, _, _, _ -> Some(visitor.Visit game)
                | _, _, _, _, _, _, _, Some game, _, _ -> Some(visitor.Visit game)
                | _, _, _, _, _, _, _, _, Some game, _ -> Some(visitor.Visit game)
                | _, _, _, _, _, _, _, _, _, Some game -> Some(visitor.Visit game)
                | _ -> None
        }

    /// Data-driven list of field clearers - keeps cleanupOldGame DRY.
    let gameFieldClearers =
        [ (fun () -> stlGameObj <- None)
          (fun () -> hoi4GameObj <- None)
          (fun () -> eu4GameObj <- None)
          (fun () -> ck2GameObj <- None)
          (fun () -> irGameObj <- None)
          (fun () -> vic2GameObj <- None)
          (fun () -> ck3GameObj <- None)
          (fun () -> vic3GameObj <- None)
          (fun () -> eu5GameObj <- None)
          (fun () -> customGameObj <- None) ]

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

    /// Data-driven mapping: config key (getter, setter) for vanilla paths.
    /// Used by the config reader loop and checkOrSetGameCache to eliminate duplication.
    let vanillaPathMap =
        [ "stellaris", (fun () -> stlVanillaPath),  (fun v -> stlVanillaPath <- v)
          "hoi4",      (fun () -> hoi4VanillaPath), (fun v -> hoi4VanillaPath <- v)
          "eu4",       (fun () -> eu4VanillaPath),  (fun v -> eu4VanillaPath <- v)
          "ck2",       (fun () -> ck2VanillaPath),  (fun v -> ck2VanillaPath <- v)
          "imperator", (fun () -> irVanillaPath),   (fun v -> irVanillaPath <- v)
          "vic2",      (fun () -> vic2VanillaPath), (fun v -> vic2VanillaPath <- v)
          "ck3",       (fun () -> ck3VanillaPath),  (fun v -> ck3VanillaPath <- v)
          "vic3",      (fun () -> vic3VanillaPath), (fun v -> vic3VanillaPath <- v)
          "eu5",       (fun () -> eu5VanillaPath),  (fun v -> eu5VanillaPath <- v) ]

    // Fallback paths for scripted variables hover (user configurable)

    let mutable remoteRepoPath: string option = None
    let mutable bundledRulesPath: string option = None

    let mutable rulesChannel: string = "stable"
    let mutable manualRulesFolder: string option = None
    let mutable useManualRules: bool = false
    let mutable validateVanilla: bool = false
    let mutable experimental: bool = false
    let mutable debugMode: bool = false
    let mutable uiLanguage: string = "en"
    let mutable maxFileSize: int = 2
    let mutable generatedStrings: string = ":0 \"REPLACE_ME\""
    let mutable clientSupportsInsertReplaceEdit: bool = false
    let mutable showInlineText: bool = false

    let mutable ignoreCodes: string array = [||]
    let mutable ignoreFiles: string array = [||]
    let mutable dontLoadPatterns: string array = [||]
    /// key: FileName (use ConcurrentDictionary instead of immutable Map to reduce GC pressure)
    let locCache = System.Collections.Concurrent.ConcurrentDictionary<string, CWError list>()

    let uiIsChinese () =
        not (String.IsNullOrWhiteSpace uiLanguage)
        && uiLanguage.StartsWith("zh", StringComparison.OrdinalIgnoreCase)

    let uiText english chinese =
        if uiIsChinese () then chinese else english

    /// Cached References().Localisation result - invalidated on RefreshLocalisationCaches.
    /// Avoids repeated materialization of ALL loc entries on every InlayHint/Hover request.
    let mutable cachedLocMap: (string * Entry) list option = None
    let mutable cachedLocMapCount = 0

    let getOrBuildLocMap (game: IGame<_>) =
        match cachedLocMap with
        | Some m -> m
        | None ->
            let m = game.References().Localisation
            cachedLocMap <- Some m
            cachedLocMapCount <- m.Length
            m

    /// SemanticTokens cache: filePath -> (contentHash, encodedDataArray, resultId)
    /// Avoids full AST re-traversal when file content hasn't changed.
    /// resultId enables delta diff against the previous snapshot.
    let semanticTokensCache = System.Collections.Concurrent.ConcurrentDictionary<string, int * int[] * string>()

    /// CodeLens cache: filePath (contentHash, lenses). A precache hash means
    /// the lenses came from the freshly loaded game type index and can be used
    /// without rereading the file on the first editor switch.
    let codeLensPrecacheHash = Int32.MinValue
    let codeLensCache = System.Collections.Concurrent.ConcurrentDictionary<string, int * CodeLens list>()
    let typeReferenceResultCache = System.Collections.Concurrent.ConcurrentDictionary<string, range list>()

    /// InlayHint cache: filePath -> (contentHash, hints)
    let inlayHintCache = System.Collections.Concurrent.ConcurrentDictionary<string, int * InlayHint list>()

    /// Short-lived same-position completion list cache.
    let completionListTtlMs = 500.0
    let completionListCacheMaxEntries = 128
    let completionListCache =
        System.Collections.Concurrent.ConcurrentDictionary<string, DateTime * CompletionList option>()

    let normaliseCachePath (filePath: string) =
        try FileInfo(filePath).FullName.Replace('\\', '/').ToLowerInvariant()
        with _ -> filePath.Replace('\\', '/').ToLowerInvariant()

    let completionListCacheKey filePath textHash line character debugMode supportsInsertReplaceEdit =
        $"{normaliseCachePath filePath}|{textHash}|{line}|{character}|{debugMode}|{supportsInsertReplaceEdit}"

    let typeReferenceResultCacheKey (typeName: string) (id: string) =
        let baseTypeName = typeName.Split('.').[0]
        $"{baseTypeName}\u001f{id}"

    let clearCompletionListCacheForFile (filePath: string) =
        let prefix = normaliseCachePath filePath + "|"
        for key in completionListCache.Keys |> Seq.toArray do
            if key.StartsWith(prefix, StringComparison.Ordinal) then
                completionListCache.TryRemove(key) |> ignore

    let evictCompletionListCacheIfNeeded () =
        if completionListCache.Count > completionListCacheMaxEntries then
            let now = DateTime.UtcNow
            for kvp in completionListCache |> Seq.toArray do
                if (now - fst kvp.Value).TotalMilliseconds > completionListTtlMs then
                    completionListCache.TryRemove(kvp.Key) |> ignore
            if completionListCache.Count > completionListCacheMaxEntries then
                let overflow = completionListCache.Count - completionListCacheMaxEntries
                completionListCache
                |> Seq.sortBy (fun kvp -> fst kvp.Value)
                |> Seq.truncate overflow
                |> Seq.iter (fun kvp -> completionListCache.TryRemove(kvp.Key) |> ignore)

    /// Cached type-index: filePath -> (typeName, id, TypeDefInfo) list.
    /// Built lazily from game.Types(), cleared on delayedAnalyze alongside codeLensCache.
    /// Avoids repeated O(all-types) scans in CodeLens handler and precaching.
    let mutable cachedGroupedTypes: Map<string, (string * string * TypeDefInfo) list> option = None

    let getOrBuildGroupedTypes (game: IGame) =
        match cachedGroupedTypes with
        | Some g -> g
        | None ->
            let pathCache = System.Collections.Generic.Dictionary<string, string>()
            let getFullName (path: string) =
                match pathCache.TryGetValue(path) with
                | true, fn -> fn
                | false, _ ->
                    let fn = try FileInfo(path).FullName with _ -> path
                    pathCache.[path] <- fn
                    fn
            let result =
                game.Types()
                |> Map.toList
                |> List.collect (fun (typeName, vs) ->
                    if typeName.Contains(".") then []
                    else vs |> Array.toList |> List.map (fun tdi -> (getFullName tdi.range.FileName, typeName, tdi)))
                |> List.groupBy (fun (fn, _, _) -> fn)
                |> Map.ofList
            cachedGroupedTypes <- Some result
            result

    let clearTypeIndexCache () =
        cachedGroupedTypes <- None

    //- Cache partition cleaning function -
    // Precise invalidation strategy: avoid unnecessary performance overhead caused by global cleanup

    /// Clear the content-related cache of a single file (semanticTokens/codeLens/inlayHint)
    let clearFileCaches (filePath: string) =
        let fullPath = try FileInfo(filePath).FullName with _ -> filePath
        for key in [ filePath; fullPath ] do
            (semanticTokensCache :> System.Collections.Generic.IDictionary<_, _>).Remove(key) |> ignore
            (codeLensCache :> System.Collections.Generic.IDictionary<_, _>).Remove(key) |> ignore
            (inlayHintCache :> System.Collections.Generic.IDictionary<_, _>).Remove(key) |> ignore
            clearCompletionListCacheForFile key
        typeReferenceResultCache.Clear()

    /// Clear the type index related cache (called after the type-defining file changes)
    let clearTypeCaches () =
        clearTypeIndexCache ()
        completionListCache.Clear()
        codeLensCache.Clear()  // CodeLens depends on type index
        typeReferenceResultCache.Clear()

    /// Clean localization related cache (called after .yml changes)
    let clearLocalisationCaches () =
        locCache.Clear()
        cachedLocMap <- None
        cachedLocMapCount <- 0

    /// Clear all derived caches (called after full refresh)
    let clearAllDerivedCaches () =
        codeLensCache.Clear()
        inlayHintCache.Clear()
        clearTypeIndexCache ()
        completionListCache.Clear()
        typeReferenceResultCache.Clear()

    /// Maximum entries before eviction.  512 files covers even very large mods;
    /// each entry is small (hash + delta-encoded int list / CodeLens list).
    let cacheMaxEntries = 512

    /// Write-time tracking for LRU eviction.  Updated on every cache write so
    /// evictIfNeeded can remove the least-recently-written entries first.
    let cacheWriteTimes = System.Collections.Concurrent.ConcurrentDictionary<string, int64>()

    do
        getPerfCacheSnapshot <-
            fun () ->
                let groupedTypeFiles =
                    cachedGroupedTypes
                    |> Option.map (fun grouped -> grouped.Count)
                    |> Option.defaultValue 0
                $" caches[semantic={semanticTokensCache.Count} codeLens={codeLensCache.Count} inlay={inlayHintCache.Count} locFiles={locCache.Count} locKeys={cachedLocMapCount} completionTTL={completionListCache.Count} typeRefs={typeReferenceResultCache.Count} groupedTypeFiles={groupedTypeFiles} cacheWriteKeys={cacheWriteTimes.Count}]"

    let getCacheSnapshotJson () =
        let groupedTypeFiles =
            cachedGroupedTypes
            |> Option.map (fun grouped -> grouped.Count)
            |> Option.defaultValue 0
        JsonValue.Record
            [| "semanticTokens", JsonValue.Number(decimal semanticTokensCache.Count)
               "codeLens", JsonValue.Number(decimal codeLensCache.Count)
               "inlayHints", JsonValue.Number(decimal inlayHintCache.Count)
               "locFiles", JsonValue.Number(decimal locCache.Count)
               "locKeys", JsonValue.Number(decimal cachedLocMapCount)
               "completionTtl", JsonValue.Number(decimal completionListCache.Count)
               "typeReferences", JsonValue.Number(decimal typeReferenceResultCache.Count)
               "groupedTypeFiles", JsonValue.Number(decimal groupedTypeFiles)
               "cacheWriteKeys", JsonValue.Number(decimal cacheWriteTimes.Count) |]

    let getCompletionSnapshotJson () =
        let state = completionRuntimeSnapshot ()
        let hitRate =
            if state.totalRequests <= 0 then 0.0
            else (double state.cacheHits) / (double state.totalRequests)
        JsonValue.Record
            [| "totalRequests", JsonValue.Number(decimal state.totalRequests)
               "cacheHits", JsonValue.Number(decimal state.cacheHits)
               "cacheMisses", JsonValue.Number(decimal state.cacheMisses)
               "cacheHitRate", JsonValue.Number(decimal hitRate)
               "lastStartedAtUnixMs", JsonValue.Number(decimal state.lastStartedAtUnixMs)
               "lastCompletedAtUnixMs", JsonValue.Number(decimal state.lastCompletedAtUnixMs)
               "lastElapsedMs", JsonValue.Number(decimal state.lastElapsedMs)
               "lastFile", JsonValue.String state.lastFile
               "lastLine", JsonValue.Number(decimal state.lastLine)
               "lastCharacter", JsonValue.Number(decimal state.lastCharacter)
               "lastItemCount", JsonValue.Number(decimal state.lastItemCount)
               "lastCacheHit", JsonValue.Boolean state.lastCacheHit
               "lastIsIncomplete", JsonValue.Boolean state.lastIsIncomplete
               "ttlCacheEntries", JsonValue.Number(decimal completionListCache.Count)
               "ttlMs", JsonValue.Number(decimal completionListTtlMs)
               "ttlMaxEntries", JsonValue.Number(decimal completionListCacheMaxEntries)
               "lastError",
                    (match state.lastError with
                     | Some error -> JsonValue.String error
                     | None -> JsonValue.Null) |]

    let clearCacheWriteTimesForFile (filePath: string) =
        let fullPath = try FileInfo(filePath).FullName with _ -> filePath
        for key in [ filePath; fullPath ] do
            cacheWriteTimes.TryRemove(key) |> ignore

    /// Evict ~25% of the least-recently-written entries when a cache exceeds cacheMaxEntries.
    let evictIfNeeded (cache: System.Collections.Concurrent.ConcurrentDictionary<'K, 'V>) =
        if cache.Count > cacheMaxEntries then
            let toRemove = cache.Count / 4
            let keys =
                cache.Keys
                |> Seq.sortBy (fun k ->
                    match cacheWriteTimes.TryGetValue(k.ToString()) with
                    | true, ticks -> ticks
                    | false, _ -> 0L)
                |> Seq.take toRemove
                |> Seq.toArray
            for k in keys do
                (cache :> System.Collections.Generic.IDictionary<'K, 'V>).Remove(k) |> ignore
                cacheWriteTimes.TryRemove(k.ToString()) |> ignore

    let cachePut (cache: System.Collections.Concurrent.ConcurrentDictionary<string, 'V>) (key: string) (value: 'V) =
        cache.[key] <- value
        cacheWriteTimes.[key] <- DateTime.UtcNow.Ticks

    let forgetFileCaches filePath =
        clearFileCaches filePath
        clearCacheWriteTimesForFile filePath

    let codeLensPositionJson line character =
        JsonValue.Record
            [| "line", JsonValue.Number(decimal line)
               "character", JsonValue.Number(decimal character) |]

    let looksLikePath (value: string) =
        value.Contains("\\")
        || value.Contains("/")
        || value.EndsWith(".txt", StringComparison.OrdinalIgnoreCase)
        || value.EndsWith(".gui", StringComparison.OrdinalIgnoreCase)
        || value.EndsWith(".gfx", StringComparison.OrdinalIgnoreCase)
        || value.EndsWith(".asset", StringComparison.OrdinalIgnoreCase)
        || value.EndsWith(".cwt", StringComparison.OrdinalIgnoreCase)

    let isCodeLensEventType (typeName: string) =
        if String.IsNullOrWhiteSpace typeName then false
        else
            let normalized = typeName.Split('.').[0].ToLowerInvariant()
            normalized = "event"
            || normalized.EndsWith("_event", StringComparison.Ordinal)

    let codeLensIdentityFieldPriority typeName field =
        match isCodeLensEventType typeName, field with
        | true, "id" -> 0
        | true, "key" -> 1
        | true, "name" -> 2
        | false, "name" -> 0
        | false, "id" -> 1
        | false, "key" -> 2
        | _ -> 3

    let tryDefinitionKeyAtLine (sourceText: string option) lineIndex =
        sourceText
        |> Option.bind (fun text ->
            if lineIndex < 0 then None
            else
                let lines = text.Split('\n')
                if lineIndex >= lines.Length then None
                else
                    let line = lines.[lineIndex].TrimEnd('\r')
                    let m = codeLensDefinitionKeyPattern.Match(line)
                    if m.Success then
                        let key = m.Groups.[1].Value.Trim('"')
                        if String.IsNullOrWhiteSpace key then None else Some key
                    else
                        None)

    let tryDefinitionKeyAtRange (sourceText: string option) (tdi: TypeDefInfo) =
        tryDefinitionKeyAtLine sourceText (int tdi.range.StartLine - 1)

    let tryDefinitionIdentityFieldAtRange (sourceText: string option) typeName (tdi: TypeDefInfo) =
        sourceText
        |> Option.bind (fun text ->
            let lines = text.Split('\n')
            let startLine = max 0 (int tdi.range.StartLine - 1)
            if startLine >= lines.Length then None
            else
                let endLine =
                    let rangeEnd = max startLine (int tdi.range.EndLine - 1)
                    min (lines.Length - 1) (min rangeEnd (startLine + 80))

                [ startLine .. endLine ]
                |> List.choose (fun lineIndex ->
                    let line = lines.[lineIndex].TrimEnd('\r')
                    let m = codeLensNameFieldPattern.Match(line)
                    if m.Success then
                        let field = m.Groups.[1].Value.ToLowerInvariant()
                        let value = m.Groups.[2].Value.Trim('"')
                        if String.IsNullOrWhiteSpace value then None
                        else Some(codeLensIdentityFieldPriority typeName field, lineIndex, value)
                    else
                        None)
                |> List.sortBy (fun (rank, lineIndex, _) -> rank, lineIndex)
                |> List.tryHead
                |> Option.map (fun (_, _, value) -> value))

    let resolveCodeLensIdentity sourceText typeName id (tdi: TypeDefInfo) =
        let resolvedTypeName =
            if looksLikePath typeName && not (looksLikePath id) then id else typeName

        let definitionKey = tryDefinitionKeyAtRange sourceText tdi
        let idLooksBroad =
            looksLikePath id
            || id = resolvedTypeName
            || (definitionKey |> Option.exists ((=) id))

        let identityField = tryDefinitionIdentityFieldAtRange sourceText resolvedTypeName tdi
        let resolvedId =
            if isCodeLensEventType resolvedTypeName then
                defaultArg identityField id
            elif idLooksBroad then
                match identityField with
                | Some fieldValue -> fieldValue
                | None ->
                    match definitionKey with
                    | Some key when key <> resolvedTypeName -> key
                    | _ -> id
            else
                id

        resolvedTypeName, resolvedId

    let makeTypeCodeLens sourceText typeName id filePath (tdi: TypeDefInfo) : LSP.Types.CodeLens =
        let typeName, id = resolveCodeLensIdentity sourceText typeName id tdi
        let range = convRangeToLSPRange tdi.range
        let line = range.start.line
        let character = range.start.character
        let uri = Uri(filePath).ToString()

        { range = range
          command =
            Some
                { title = $"%s{typeName}: %s{id}"
                  command = "cwtools.showTypeReferences"
                  arguments =
                    [ JsonValue.String uri
                      codeLensPositionJson line character
                      JsonValue.String typeName
                      JsonValue.String id ] }
          data =
            JsonValue.Record
                [| "typeName", JsonValue.String typeName
                   "id", JsonValue.String id
                   "filePath", JsonValue.String filePath
                   "line", JsonValue.Number(decimal line)
                   "character", JsonValue.Number(decimal character) |] }

    /// Compute a SemanticTokens delta between two encoded int arrays.
    /// Each token occupies 5 ints (deltaLine, deltaChar, length, tokenType, tokenModifiers).
    /// Walks stride-5 from both ends to find the changed region.
    let computeDelta (oldTokens: int[]) (newTokens: int[]) : SemanticTokensEdit =
        let mutable startIndex = 0
        while startIndex < oldTokens.Length
              && startIndex < newTokens.Length
              && oldTokens.[startIndex] = newTokens.[startIndex] do
            startIndex <- startIndex + 5

        let mutable oldEnd = oldTokens.Length - 5
        let mutable newEnd = newTokens.Length - 5
        while oldEnd >= startIndex
              && newEnd >= startIndex
              && oldTokens.[oldEnd] = newTokens.[newEnd] do
            oldEnd <- oldEnd - 5
            newEnd <- newEnd - 5

        let deleteCount = max 0 (oldEnd - startIndex + 5)
        let inserted = newTokens.[startIndex .. newEnd + 4]
        { start = startIndex
          deleteCount = deleteCount
          data = Array.toList inserted }

    /// Allocation-based GC threshold - triggers non-blocking Gen2 collection
    /// after ~50 MB of new allocations instead of a simple locCache.Count check.
    let mutable lastGCAllocBytes = GC.GetTotalAllocatedBytes(false)
    let gcThresholdBytes = 200L * 1024L * 1024L

    let maybeCollectGarbage () =
        let currentBytes = GC.GetTotalAllocatedBytes(false)
        if currentBytes - lastGCAllocBytes > gcThresholdBytes then
            GC.Collect(2, GCCollectionMode.Optimized, false, false)
            lastGCAllocBytes <- GC.GetTotalAllocatedBytes(false)

    /// Deterministic content hash using FNV-1a instead of string.GetHashCode()
    /// because string.GetHashCode() is randomized per-process in .NET Core.
    let contentHash (text: string) =
        let mutable hash = 2166136261u
        for i = 0 to text.Length - 1 do
            hash <- (hash ^^^ (uint32 text.[i])) * 16777619u
        int hash

    let mutable lastFocusedFile: string option = None

    /// Atomic flag 0 = idle, 1 = refreshing.  Use Interlocked.CompareExchange
    /// instead of a plain mutable bool to prevent two DidOpenTextDocument handlers
    /// from both passing the "false" check and starting duplicate Tasks.
    let currentlyRefreshingFiles = ref 0

    let (|TrySuccess|TryFailure|) tryResult =
        match tryResult with
        | true, value -> TrySuccess value
        | _ -> TryFailure

    /// Data-driven mapping for language parsing in DidChangeConfiguration.
    /// Each entry: (GameType, parser (string -> Lang), default (unit -> Lang array))
    let langConfigMap =
        [ STL,  (fun (s: string) -> match STLLang.TryParse<STLLang> s with TrySuccess v -> Lang.STL v | _ -> Lang.STL STLLang.English), (fun () -> [| Lang.STL STLLang.English |])
          EU4,  (fun s -> match EU4Lang.TryParse<EU4Lang> s with TrySuccess v -> Lang.EU4 v | _ -> Lang.EU4 EU4Lang.English), (fun () -> [| Lang.EU4 EU4Lang.English |])
          HOI4, (fun s -> match HOI4Lang.TryParse<HOI4Lang> s with TrySuccess v -> Lang.HOI4 v | _ -> Lang.HOI4 HOI4Lang.English), (fun () -> [| Lang.HOI4 HOI4Lang.English |])
          CK2,  (fun s -> match CK2Lang.TryParse<CK2Lang> s with TrySuccess v -> Lang.CK2 v | _ -> Lang.CK2 CK2Lang.English), (fun () -> [| Lang.CK2 CK2Lang.English |])
          IR,   (fun s -> match IRLang.TryParse<IRLang> s with TrySuccess v -> Lang.IR v | _ -> Lang.IR IRLang.English), (fun () -> [| Lang.IR IRLang.English |])
          VIC2, (fun s -> match VIC2Lang.TryParse<VIC2Lang> s with TrySuccess v -> Lang.VIC2 v | _ -> Lang.VIC2 VIC2Lang.English), (fun () -> [| Lang.VIC2 VIC2Lang.English |])
          CK3,  (fun s -> match CK3Lang.TryParse<CK3Lang> s with TrySuccess v -> Lang.CK3 v | _ -> Lang.CK3 CK3Lang.English), (fun () -> [| Lang.CK3 CK3Lang.English |])
          VIC3, (fun s -> match VIC3Lang.TryParse<VIC3Lang> s with TrySuccess v -> Lang.VIC3 v | _ -> Lang.VIC3 VIC3Lang.English), (fun () -> [| Lang.VIC3 VIC3Lang.English |])
          EU5,  (fun s -> match EU5Lang.TryParse<EU5Lang> s with TrySuccess v -> Lang.EU5 v | _ -> Lang.EU5 EU5Lang.English), (fun () -> [| Lang.EU5 EU5Lang.English |])
          Custom, (fun s -> match CustomLang.TryParse<CustomLang> s with TrySuccess v -> Lang.Custom v | _ -> Lang.Custom CustomLang.English), (fun () -> [| Lang.Custom CustomLang.English |]) ]

    let sevToDiagSev =
        function
        | Severity.Error -> DiagnosticSeverity.Error
        | Severity.Warning -> DiagnosticSeverity.Warning
        | Severity.Information -> DiagnosticSeverity.Information
        | Severity.Hint -> DiagnosticSeverity.Hint
        | _ -> DiagnosticSeverity.Information

    let diagnosticCategoryAndHint (code: string) (message: string) =
        let lower = message.ToLowerInvariant()
        let has (needle: string) = lower.Contains(needle)
        if code.StartsWith("CW001", StringComparison.OrdinalIgnoreCase)
           || has "syntax"
           || has "parse"
           || has "unexpected"
           || has "brace"
           || has "missing '}'"
           || has "unmatched" then
            "brace_or_syntax_error",
            "Inspect the nearest block boundaries and fix the smallest malformed syntax region before changing semantic content."
        elif has "localisation"
             || has "localization"
             || has "localised"
             || has "localized" then
            "missing_localisation",
            "Verify the key in localisation indexes and project text before creating or updating localisation."
        elif has "scope" then
            "scope_mismatch",
            "Query the current scope and the relevant rule before changing triggers, effects, or scope transitions."
        elif has "sprite"
             || has "gfx_"
             || has "spritetype"
             || has "picture" then
            "unknown_sprite",
            "Resolve the sprite through project and vanilla .gfx/.asset candidates before editing the reference."
        elif has "sound"
             || has "music"
             || has ".asset" then
            "unknown_sound",
            "Resolve the sound or music asset through project and vanilla candidates before editing the reference."
        elif has "duplicate"
             || has "already defined"
             || has "redeclared" then
            "duplicate_definition",
            "Find the existing definition before deleting, renaming, or moving the duplicate entry."
        elif has "expected value of type"
             || has "invalid value"
             || has "not a valid value"
             || has "wrong type" then
            "invalid_value_type",
            "Query the field rule and nearby scope before replacing the value with a type-correct candidate."
        elif has "trigger"
             || has "effect" then
            "unknown_trigger_effect",
            "Check CWT rules, scripted triggers/effects, and definitions before renaming or creating identifiers."
        elif has "unknown"
             || has "not found"
             || has "could not find"
             || has "does not exist"
             || has "unresolved" then
            "missing_definition",
            "Verify the referenced definition across workspace and vanilla indexes before creating a replacement."
        else
            "unknown",
            "Gather nearby file context, rule data, and current diagnostics before applying another edit."

    let diagnosticData (code: string) (message: string) =
        let category, repairHint = diagnosticCategoryAndHint code message
        let tryGroup pattern group =
            let m =
                System.Text.RegularExpressions.Regex.Match(
                    message,
                    pattern,
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase)

            if m.Success && m.Groups.Count > group && m.Groups[group].Success then
                let value = m.Groups[group].Value.Trim()
                if String.IsNullOrWhiteSpace value then None else Some value
            else
                None

        let firstSome candidates =
            candidates |> List.tryPick id

        let cleanSymbol (value: string) =
            value.Trim().Trim([| '\''; '"'; '`'; '.'; ','; ':'; ';'; ')' |])

        let expectedType =
            firstSome
                [ tryGroup @"expected value of type\s+['""]?([A-Za-z0-9_.:-]+)" 1
                  tryGroup @"expected\s+['""]?([A-Za-z0-9_.:-]+)['""]?\s+(?:scope|type|value)" 1
                  tryGroup @"([A-Za-z0-9_.:-]+)\s+expected" 1 ]

        let actualType =
            firstSome
                [ tryGroup @"(?:got|actual|found)\s+['""]?([A-Za-z0-9_.:-]+)" 1
                  tryGroup @"but\s+(?:got|found)\s+['""]?([A-Za-z0-9_.:-]+)" 1 ]

        let scope =
            firstSome
                [ tryGroup @"scope\s*[:=]\s*['""]?([A-Za-z0-9_.:-]+)" 1
                  tryGroup @"(?:root|this|from|prev|fromfrom)\s*[:=]\s*['""]?([A-Za-z0-9_.:-]+)" 1 ]

        let symbol =
            firstSome
                [ tryGroup @"['""]([^'""]{2,160})['""]" 1
                  tryGroup @"\b(GFX_[A-Za-z0-9_.:-]+)\b" 1
                  tryGroup @"\b([A-Za-z_][A-Za-z0-9_.:-]{2,})\s+(?:not found|does not exist|is unknown|already defined)" 1 ]
            |> Option.map cleanSymbol

        let semanticFields =
            [ "expectedType", expectedType
              "actualType", actualType
              "scope", scope
              "symbol", symbol ]
            |> List.choose (fun (name, value) ->
                value
                |> Option.filter (String.IsNullOrWhiteSpace >> not)
                |> Option.map (fun text -> name, JsonValue.String text))

        JsonValue.Record
            ([ "category", JsonValue.String category
               "repairHint", JsonValue.String repairHint
               "confidence", JsonValue.String "low"
               "metadataSource", JsonValue.String "message_heuristic" ]
             @ semanticFields
             |> List.toArray)

    let diagnosticUri (f: string) =
        (match Uri.TryCreate(f, UriKind.Absolute) with
         | TrySuccess value -> value
         | TryFailure ->
             logWarning f
             Uri "/")

    let parserErrorToDiagnostics e =
        let code, sev, file, error, (position: range), length, related = e

        let startC, endC =
            match length with
            | 0 -> 0, (int position.StartColumn)
            | _ -> (int position.StartColumn), (int position.StartColumn) + length

        let startLine = (int position.StartLine) - 1
        let startLine = max startLine 0

        let result =
            { range =
                { start = { line = startLine; character = startC }
                  ``end`` = { line = startLine; character = endC } }
              severity = Some(sevToDiagSev sev)
              code = Some code
              source = Some code
              message = error
              data = Some(diagnosticData code error)
              relatedInformation =
                related
                |> Option.map (
                    List.map (fun rel ->
                        { DiagnosticRelatedInformation.location =
                            { uri = diagnosticUri rel.location.FileName
                              range = convRangeToLSPRange rel.location }
                          message = rel.message })
                )
                |> Option.defaultValue [] }

        (file, result)

    let diagnosticFilter (f: string, d) =
        match (f, d) with
        | _, { Diagnostic.code = Some code } when Array.contains code ignoreCodes -> false
        | f, _ when Array.contains (Path.GetFileName f) ignoreFiles -> false
        | _, _ -> true

    let diagnosticCounts (diagnostics: Diagnostic list) =
        let errCount =
            diagnostics
            |> List.filter (fun d -> d.severity = Some(sevToDiagSev Severity.Error))
            |> List.length
        let warnCount =
            diagnostics
            |> List.filter (fun d -> d.severity = Some(sevToDiagSev Severity.Warning))
            |> List.length
        errCount, warnCount

    let setFileDiagnosticStateWithEpoch filePath epoch freshness pendingKinds diagnostics =
        let errCount, warnCount = diagnosticCounts diagnostics
        let validatedVersion = docs.GetVersionByPath(filePath)
        let state =
            { version = validatedVersion
              validatedVersion = validatedVersion
              epoch = epoch
              updatedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
              freshness = freshness
              pendingGlobalKinds = pendingKinds
              errorCount = errCount
              diagnostics = diagnostics
              warningCount = warnCount }
        fileDiagnosticStates.[filePath] <- state

    let nextDiagnosticEpoch () =
        System.Threading.Interlocked.Increment(diagnosticEpoch)

    let setFileDiagnosticState filePath freshness pendingKinds diagnostics =
        setFileDiagnosticStateWithEpoch filePath (nextDiagnosticEpoch ()) freshness pendingKinds diagnostics

    let diagnosticsForFile filePath diagnostics =
        let normalisedPath = normaliseCachePath filePath
        diagnostics
        |> List.choose (fun (f, d) ->
            if normaliseCachePath f = normalisedPath then Some d else None)

    let sendDiagnostics s =
        s
        |> List.groupBy fst
        |> List.map (
            (fun (f, rs) -> f, rs |> List.filter diagnosticFilter)
            >> (fun (f, rs) ->
                try
                    { uri =
                        diagnosticUri f
                      diagnostics = List.map snd rs }
                with e ->
                    failwith $"%A{e} %A{rs}")
        )
        |> List.iter client.PublishDiagnostics

    let mutable delayedLocUpdate = false

    let refreshDomainLock = obj()
    let mutable pendingRefreshDomains = Set.empty<string>
    let mutable lastGlobalRefreshAt = DateTime.MinValue
    let mutable lastLocalisationRefreshAt = DateTime.MinValue
    let mutable lastRefreshCompletedDomains: string list = []
    let mutable lastRefreshDomainStatus = "not_started"

    let addPendingRefreshDomains domains =
        lock refreshDomainLock (fun () ->
            pendingRefreshDomains <- domains |> List.fold (fun acc domain -> Set.add domain acc) pendingRefreshDomains)

    let pendingRefreshDomainList () =
        lock refreshDomainLock (fun () -> pendingRefreshDomains |> Set.toList)

    let refreshDomainSnapshotJson () =
        lock refreshDomainLock (fun () ->
            JsonValue.Record
                [| "pendingDomains", JsonValue.Array(pendingRefreshDomains |> Seq.map JsonValue.String |> Seq.toArray)
                   "lastCompletedDomains", JsonValue.Array(lastRefreshCompletedDomains |> List.map JsonValue.String |> Array.ofList)
                   "lastGlobalRefreshAtUnixMs", JsonValue.Number(decimal (dateTimeToUnixMs lastGlobalRefreshAt))
                   "lastLocalisationRefreshAtUnixMs", JsonValue.Number(decimal (dateTimeToUnixMs lastLocalisationRefreshAt))
                   "lastStatus", JsonValue.String lastRefreshDomainStatus |])

    let completeRefreshDomains domains status =
        lock refreshDomainLock (fun () ->
            let completed = domains |> List.distinct
            pendingRefreshDomains <- completed |> List.fold (fun acc domain -> Set.remove domain acc) pendingRefreshDomains
            lastRefreshCompletedDomains <- completed
            lastRefreshDomainStatus <- status
            if completed |> List.exists (fun d -> d <> "localisation") then
                lastGlobalRefreshAt <- DateTime.UtcNow
            if completed |> List.contains "localisation" then
                lastLocalisationRefreshAt <- DateTime.UtcNow)

    /// Paths that define types/enums/scopes - edits here require full RefreshCaches
    let typeDefiningSegments = [| "/common/"; "\\common\\"; "/interface/"; "\\interface\\"; "/gfx/"; "\\gfx\\"; "/map/"; "\\map\\"; "/prescripted_countries/"; "\\prescripted_countries\\" |]
    let isTypeDefiningPath (path: string) =
        let lp = path.ToLowerInvariant()
        typeDefiningSegments |> Array.exists (fun seg -> lp.Contains(seg))

    let refreshDomainsForPath (path: string) =
        let lp = path.ToLowerInvariant().Replace('\\', '/')
        [ if lp.EndsWith(".yml") then
              yield "localisation"
          if lp.Contains("/common/") then
              yield "types"
              yield "rules"
          if lp.Contains("/interface/") || lp.Contains("/gfx/") then
              yield "sprites_sounds"
              yield "types"
          if lp.Contains("/map/") || lp.Contains("/prescripted_countries/") then
              yield "types" ]
        |> List.distinct

    /// When true, the next delayedAnalyze must run full RefreshCaches
    let mutable needsTypeRefresh = false
    /// Last edit that dirtied the global type/reference indexes.
    let mutable lastTypeRefreshRequestAt = DateTime.MinValue
    /// Last completed full RefreshCaches cycle.
    let mutable lastTypeRefreshCompletedAt = DateTime.MinValue
    /// Avoid rebuilding multi-GB global indexes while the user is still typing.
    let typeRefreshQuietPeriod = TimeSpan.FromSeconds(5.0)
    /// Bound full cache rebuild cadence during normal editing sessions.
    let typeRefreshCooldown = TimeSpan.FromSeconds(20.0)
    /// How many consecutive deep-analyze cycles have skipped RefreshCaches
    let mutable refreshSkipCount = 0
    /// Maximum consecutive skips before forcing a full refresh
    let maxRefreshSkipCount = 10

    let markFileStale filePath reason =
        let pendingKinds =
            match reason with
            | "localisation" -> [ "localisation" ]
            | "types" -> [ "types" ]
            | _ -> refreshDomainsForPath filePath
        setFileDiagnosticState filePath Stale pendingKinds []

    //-Lightweight bracket scanner -
    // Provide precise bracket error location when parser fails
    // O(n) single pass, skipping line comments (#) and double-quoted strings
    let scanBraceIssues (text: string) (filePath: string) =
        let lines = text.Split('\n')
        let stack = System.Collections.Generic.Stack<int * int>()  // (lineIdx, col)
        let issues = ResizeArray<string * Severity * string * string * range * int * (CWRelatedError list) option>()
        for lineIdx in 0 .. lines.Length - 1 do
            let line = lines.[lineIdx]
            let mutable col = 0
            let mutable inString = false
            while col < line.Length do
                let ch = line.[col]
                match ch with
                | '#' when not inString ->
                    col <- line.Length   // Skip end-of-line comments
                | '"' ->
                    inString <- not inString
                    col <- col + 1
                | '{' when not inString ->
                    stack.Push(lineIdx, col)
                    col <- col + 1
                | '}' when not inString ->
                    if stack.Count = 0 then
                        let pos = mkRange filePath (mkPos (lineIdx + 1) col) (mkPos (lineIdx + 1) (col + 1))
                        issues.Add("CW001_UNMATCHED_CLOSE_BRACE", Severity.Error, filePath,
                            sprintf "Unmatched '}' - no matching '{' found", pos, 1, None)
                    else
                        stack.Pop() |> ignore
                    col <- col + 1
                | _ ->
                    col <- col + 1
        // Unclosed left bracket
        while stack.Count > 0 do
            let openLine, openCol = stack.Pop()
            let pos = mkRange filePath (mkPos (openLine + 1) openCol) (mkPos (openLine + 1) (openCol + 1))
            issues.Add("CW001_MISSING_CLOSE_BRACE", Severity.Error, filePath,
                sprintf "Missing '}' for '{' opened at line %d col %d" (openLine + 1) (openCol + 1),
                pos, 1, None)
        issues |> Seq.toList

    let splitTopLevelFragments (text: string) =
        let lines = text.Split('\n')
        let fragments = ResizeArray<int * int * string>()
        let mutable depth = 0
        let mutable startLine = 0
        let mutable inString = false
        let mutable brokenDepth = false
        for lineIdx in 0 .. lines.Length - 1 do
            let line = lines.[lineIdx]
            let mutable col = 0
            while col < line.Length do
                match line.[col] with
                | '#' when not inString -> col <- line.Length
                | '"' ->
                    inString <- not inString
                    col <- col + 1
                | '{' when not inString ->
                    depth <- depth + 1
                    col <- col + 1
                | '}' when not inString ->
                    if depth = 0 then brokenDepth <- true
                    else depth <- depth - 1
                    col <- col + 1
                | _ -> col <- col + 1
            if depth = 0 && not brokenDepth then
                let fragmentText = String.Join("\n", lines.[startLine .. lineIdx]).Trim()
                if fragmentText.Length > 0 then
                    fragments.Add(startLine + 1, lineIdx + 1, fragmentText)
                startLine <- lineIdx + 1
        if startLine < lines.Length then
            let fragmentText = String.Join("\n", lines.[startLine .. lines.Length - 1]).Trim()
            if fragmentText.Length > 0 then
                fragments.Add(startLine + 1, lines.Length, fragmentText)
        fragments |> Seq.toList

    let scanRecoveryIssues (text: string) (filePath: string) =
        let fragments = splitTopLevelFragments text
        let mutable parsedHealthy = 0
        let issues = ResizeArray<string * Severity * string * string * range * int * (CWRelatedError list) option>()
        for (startLine, endLine, fragmentText) in fragments do
            if scanBraceIssues fragmentText filePath |> List.isEmpty then
                match CKParser.parseString fragmentText filePath with
                | Success _ -> parsedHealthy <- parsedHealthy + 1
                | Failure(msg, p, _) ->
                    let line = startLine + int p.Position.Line - 1
                    let col = int p.Position.Column
                    let pos = mkRange filePath (mkPos line col) (mkPos line (col + 1))
                    issues.Add("CW001_RECOVERY_SKIPPED_BLOCK", Severity.Warning, filePath,
                        sprintf "Skipped structurally invalid top-level block around lines %d-%d: %s" startLine endLine msg,
                        pos, 1, None)
        if parsedHealthy > 0 then
            let pos = mkRange filePath (mkPos 1 0) (mkPos 1 1)
            issues.Add("CW001_STRUCTURAL_RECOVERY", Severity.Information, filePath,
                sprintf "Parser recovery parsed %d healthy top-level block(s); rule diagnostics may be stale until the syntax error is fixed." parsedHealthy,
                pos, 1, None)
        issues |> Seq.toList

    /// isEditAction: true for DidChange/DidSave (content changed), false for DidOpen/DidFocus (content unchanged).
    let lint (doc: Uri) (shallowAnalyze: bool) (forceDisk: bool) (isEditAction: bool) : Async<unit> =
        async {
            let name = getPathFromDoc doc
            // Invalidate codelens cache for THIS file only
            forgetFileCaches name

            if name.EndsWith(".yml") then
                if isEditAction && not shallowAnalyze then
                    delayedLocUpdate <- true
                    addPendingRefreshDomains [ "localisation" ]
                    clearLocalisationCaches ()
                if isEditAction then markFileStale name "localisation"

            // Mark type refresh needed ONLY if the file was EDITED (not just opened).
            // Opening a file does not change its content, so the type/enum index is still valid.
            if isEditAction && isTypeDefiningPath name && not shallowAnalyze then
                needsTypeRefresh <- true
                lastTypeRefreshRequestAt <- DateTime.UtcNow
                let domains = refreshDomainsForPath name |> List.filter (fun domain -> domain <> "localisation")
                addPendingRefreshDomains (if domains.IsEmpty then [ "types" ] else domains)
                clearTypeCaches ()
                markFileStale name "path"

            // Optimization: only obtain the file text once to avoid repeated GetText calls
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
                | Some _ when name.EndsWith(".shader", StringComparison.OrdinalIgnoreCase) -> []
                | Some _ when name.EndsWith(".fxh", StringComparison.OrdinalIgnoreCase) -> []
                | Some t ->
                    let parsed = CKParser.parseString t name

                    match name, parsed with
                    | x, _ when x.EndsWith(".yml") -> []
                    | _, Success _ -> []
                    | _, Failure(msg, p, _) ->
                        let parserDiag =
                            [ ("CW001", Severity.Error, name, msg, (getRange p.Position p.Position), 0, None) ]
                        // Run the bracket scanner when Parser fails to provide more precise diagnostics
                        let braceIssues = scanBraceIssues t name
                        let recoveryIssues = scanRecoveryIssues t name
                        parserDiag @ braceIssues @ recoveryIssues

            let locErrors =
                match locCache.TryGetValue(doc.LocalPath) with
                | true, errors -> errors
                | false, _ -> []
                |> List.map (fun e ->
                    (e.code, e.severity, e.range.FileName, e.message, e.range, e.keyLength, e.relatedErrors))
            // logDiag (sprintf "lint le %A" (locCache.TryFind (doc.LocalPath) |> Option.defaultValue []))
            
            let errors =
                match gameObj with
                | None -> parserErrors @ locErrors
                | Some game ->
                    gameStateLock.EnterWriteLock()
                    let allocBeforeUpdate = GC.GetTotalAllocatedBytes(false)
                    let astErrors = 
                        try game.UpdateFile shallowAnalyze name filetext
                        finally gameStateLock.ExitWriteLock()
                        |> List.map (fun e ->
                            (e.code, e.severity, e.range.FileName, e.message, e.range, e.keyLength, e.relatedErrors))
                    let allocAfterUpdate = GC.GetTotalAllocatedBytes(false)
                    monitorLog Lint $"UpdateFile file={name} shallow={shallowAnalyze} allocDeltaMB={(allocAfterUpdate - allocBeforeUpdate) / 1048576L}{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"
                    
                    if name.EndsWith(".yml") then
                        // We still need to call game.UpdateFile so the VFS gets the new text,
                        // but we rely on locCache/RefreshLocalisationCaches for the actual validation errors.
                        parserErrors @ locErrors
                    else
                        parserErrors @ locErrors @ astErrors

            //-Publish diagnosis and update freshness status-
            let diagnosticsList =
                match errors with
                | [] -> []
                | x -> x |> List.map parserErrorToDiagnostics
            let visibleDiagnosticsList = diagnosticsList |> List.filter diagnosticFilter

            // Publish to VS Code Problems panel
            // IMPORTANT: You must ensure that the currently edited file always receives diagnostic updates,
            // Even though there is no entry for this file in diagnosticsList (bugs all fixed)
            match visibleDiagnosticsList with
            | [] -> client.PublishDiagnostics { uri = doc; diagnostics = [] }
            | x ->
                x |> sendDiagnostics
                // If the current file is not in diagnosticsList, reissue empty diagnostics to clear old errors
                let currentFileDiags = x |> List.filter (fun (f, _) -> f = name)
                if currentFileDiags.IsEmpty then
                    client.PublishDiagnostics { uri = doc; diagnostics = [] }

            //Update diagnostic freshness status table
            let newEpoch = System.Threading.Interlocked.Increment(diagnosticEpoch)
            let pendingKinds = pendingRefreshDomainList ()
            let freshness =
                if pendingKinds.IsEmpty then Fresh else Pending
            setFileDiagnosticStateWithEpoch name newEpoch freshness pendingKinds (diagnosticsForFile name visibleDiagnosticsList)

            visibleDiagnosticsList
            |> List.groupBy fst
            |> List.iter (fun (filePath, entries) ->
                if normaliseCachePath filePath <> normaliseCachePath name then
                    setFileDiagnosticStateWithEpoch filePath newEpoch freshness pendingKinds (entries |> List.map snd))
            perfLintCount <- perfLintCount + 1
            maybePerfReport "lint"
        }

    let mutable delayTime = TimeSpan(0, 0, 5)


    let delayedAnalyze (forceGlobalRefresh: bool) =
        match gameObj with
        | Some game ->
            let timestamp = Stopwatch.GetTimestamp()
            let allocBefore = GC.GetTotalAllocatedBytes(false)
            let mutable refreshStatus = "not_needed"
            let now = DateTime.UtcNow
            let pendingDomainsBeforeAnalyze = pendingRefreshDomainList ()
            let quietEnough =
                lastTypeRefreshRequestAt = DateTime.MinValue
                || now - lastTypeRefreshRequestAt >= typeRefreshQuietPeriod
            let cooldownElapsed =
                lastTypeRefreshCompletedAt = DateTime.MinValue
                || now - lastTypeRefreshCompletedAt >= typeRefreshCooldown
            let skipLimitReached = refreshSkipCount >= maxRefreshSkipCount
            // Even force=true refreshes respect a minimum 2s cooldown to prevent
            // storm-like rebuilds when saving multiple files in rapid succession.
            let forceCooldownOk =
                lastTypeRefreshCompletedAt = DateTime.MinValue
                || now - lastTypeRefreshCompletedAt >= TimeSpan.FromSeconds(2.0)
            // Conditionally skip RefreshCaches while edits are still arriving.
            let doRefresh =
                needsTypeRefresh
                && (skipLimitReached
                    || (forceGlobalRefresh && forceCooldownOk)
                    || (quietEnough && cooldownElapsed))
            let mutable didGlobalWork = false
            gameStateLock.EnterWriteLock()
            try
                if doRefresh then
                    game.RefreshCaches()
                    let allocAfterRefresh = GC.GetTotalAllocatedBytes(false)
                    refreshStatus <- if forceGlobalRefresh then "refresh_caches_forced" else "refresh_caches"
                    monitorLog Refresh $"RefreshCaches allocDeltaMB={(allocAfterRefresh - allocBefore) / 1048576L} force={forceGlobalRefresh} skipLimit={skipLimitReached} {getPerfMemorySnapshot()}{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"
                    perfRefreshCachesCount <- perfRefreshCachesCount + 1
                    didGlobalWork <- true
                    // Force blocking Gen2 GC after RefreshCaches: old RuleValidationService/InfoService
                    // instances are dead, reclaim their large memoization dictionaries immediately.
                    GC.Collect(2, GCCollectionMode.Default, true, true)
                    GC.WaitForPendingFinalizers()
                    needsTypeRefresh <- false
                    lastTypeRefreshCompletedAt <- DateTime.UtcNow
                    refreshSkipCount <- 0
                    let completed =
                        pendingDomainsBeforeAnalyze
                        |> List.filter (fun domain -> domain <> "localisation")
                        |> fun domains -> if domains.IsEmpty then [ "types" ] else domains
                    completeRefreshDomains completed refreshStatus
                elif needsTypeRefresh then
                    refreshSkipCount <- refreshSkipCount + 1
                    refreshStatus <- $"deferred:skip={refreshSkipCount};quiet={quietEnough};cooldown={cooldownElapsed};force={forceGlobalRefresh}"
                    monitorLog Refresh $"RefreshCaches skipped pending=true skip={refreshSkipCount} quiet={quietEnough} cooldown={cooldownElapsed} force={forceGlobalRefresh}{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"
                else
                    refreshSkipCount <- 0
                    refreshStatus <- "not_needed"
                    monitorLog Refresh $"RefreshCaches skipped pending=false{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"

                let allocBeforeLoc = GC.GetTotalAllocatedBytes(false)
                let mutable didLocRefresh = false
                if delayedLocUpdate then
                    logDiag "delayedLocUpdate true"
                    game.RefreshLocalisationCaches()
                    cachedLocMap <- None  // invalidate cached loc entries
                    cachedLocMapCount <- 0
                    delayedLocUpdate <- false
                    didLocRefresh <- true
                    didGlobalWork <- true

                    // Use Dictionary: Clear and refill
                    locCache.Clear()
                    for fileName, errors in game.LocalisationErrors(true, true) |> List.groupBy _.range.FileName do
                        locCache.[fileName] <- errors
                    completeRefreshDomains [ "localisation" ] "refresh_localisation"
                elif doRefresh then
                    logDiag "delayedLocUpdate false"

                    locCache.Clear()
                    for fileName, errors in game.LocalisationErrors(false, true) |> List.groupBy _.range.FileName do
                        locCache.[fileName] <- errors
                    didLocRefresh <- true
                    if pendingDomainsBeforeAnalyze |> List.contains "localisation" then
                        completeRefreshDomains [ "localisation" ] "refresh_localisation_after_global"
                else
                    logDiag "LocErrors skipped: no localisation or type refresh"
                if didLocRefresh then evictIfNeeded locCache
                let allocAfterLoc = GC.GetTotalAllocatedBytes(false)
                if didLocRefresh then
                    let locErrorCount = locCache.Values |> Seq.sumBy List.length
                    monitorLog Localisation $"LocErrors allocDeltaMB={(allocAfterLoc - allocBeforeLoc) / 1048576L} locFiles={locCache.Count} locErrors={locErrorCount} cachedLocKeys={cachedLocMapCount}"
                    perfRefreshLocCount <- perfRefreshLocCount + 1
                else
                    monitorLog Localisation $"LocErrors skipped delayedLocUpdate={delayedLocUpdate} doRefresh={doRefresh} locFiles={locCache.Count} cachedLocKeys={cachedLocMapCount}"
                if allocAfterLoc - allocBeforeLoc > gcThresholdBytes then
                    GC.Collect(2, GCCollectionMode.Optimized, false, false)

                // Effect/trigger sets may have changed invalidate all semantic caches.
                // Unlike the old Clear() which caused VSCode to lose all highlighting,
                // we now keep stale entries: SemanticTokensFull will return cached data
                // when the entity is not yet rebuilt, then VSCode re-requests once the
                // AST is ready. We clear codeLens because it's cheaper to recompute.
                if doRefresh then
                    clearAllDerivedCaches ()
                elif didLocRefresh then
                    inlayHintCache.Clear()

                // - Update the diagnostic status of all files to Fresh -
                //After delayedAnalyze completes the global refresh, clear the pending mark
                if didGlobalWork then
                    let freshEpoch = System.Threading.Interlocked.Increment(diagnosticEpoch)
                    let nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    let remainingPendingDomains = pendingRefreshDomainList ()
                    let nextFreshness =
                        if remainingPendingDomains.IsEmpty then Fresh else Pending
                    for kvp in fileDiagnosticStates do
                        if kvp.Value.freshness <> nextFreshness || kvp.Value.pendingGlobalKinds <> remainingPendingDomains then
                            fileDiagnosticStates.[kvp.Key] <-
                                { kvp.Value with
                                    epoch = freshEpoch
                                    updatedAtUnixMs = nowMs
                                    freshness = nextFreshness
                                    pendingGlobalKinds = remainingPendingDomains }
            finally
                gameStateLock.ExitWriteLock()

            let time = Stopwatch.GetElapsedTime(timestamp)
            updateValidationRuntime (fun state ->
                { state with
                    lastAnalyzeElapsedMs = int64 (time.TotalMilliseconds)
                    lastAnalyzeCompletedAtUnixMs = nowUnixMs ()
                    lastAnalyzeDidGlobalWork = didGlobalWork
                    lastRefreshStatus = refreshStatus })

            delayTime <-
                TimeSpan(Math.Min(TimeSpan(0, 0, 30).Ticks, Math.Max(TimeSpan(0, 0, 1, 500).Ticks, 2L * time.Ticks)))
            
            // Regularly clean the cache of non-existing files to prevent memory leaks.
            // This scans all known files, so only do it after real global work.
            if didGlobalWork then
                try
                    let existingFiles = 
                        game.AllFiles() 
                        |> List.choose (fun r ->
                            let filePath =
                                match r with
                                | CWTools.Games.EntityResource(f, _) -> Some f
                                | CWTools.Games.FileWithContentResource(f, _) -> Some f
                                | CWTools.Games.FileResource(f, _) -> Some f
                            filePath |> Option.map (fun f -> try FileInfo(f).FullName with _ -> f))
                        |> Set.ofList
                    game.CleanupCache existingFiles
                    let existingNormalised =
                        existingFiles
                        |> Seq.map normaliseCachePath
                        |> Set.ofSeq
                    for staleKey in fileDiagnosticStates.Keys |> Seq.filter (fun f -> not (existingNormalised.Contains(normaliseCachePath f))) |> Seq.toArray do
                        fileDiagnosticStates.TryRemove(staleKey) |> ignore
                with e ->
                    logDiag $"CleanupCache failed: {e.Message}"
            
            // L6/L3 Fix: Use non-blocking Gen2 GC only after a full refresh to
            // reclaim large rule data; avoid frequent mid-stream GC in hot path.
            if didGlobalWork then maybeCollectGarbage ()

            // Memory diagnostics: track growth sources after each analyze pass.
            let allocTotal = GC.GetTotalAllocatedBytes(false)
            let sm = CWTools.Utilities.StringResource.stringManager
            monitorLog Memory $"AnalyzePass cycleAllocMB={(allocTotal - allocBefore) / 1048576L} strings={sm.StringCount} ints={sm.IntCount} {getPerfMemorySnapshot()}{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"
            maybePerfReport "delayedAnalyze"
            didGlobalWork
        | None ->
            updateValidationRuntime (fun state ->
                { state with
                    lastAnalyzeElapsedMs = 0L
                    lastAnalyzeCompletedAtUnixMs = nowUnixMs ()
                    lastAnalyzeDidGlobalWork = false
                    lastRefreshStatus = "no_game" })
            false


    let lintAgent =
        MailboxProcessor.Start(fun agent ->
            let mutable nextAnalyseTime = DateTime.Now
            let mutable needsDeepAnalyse = false

            let analyzeTask (uri: Uri) (force: bool) (isEditAction: bool) =
                async {
                    let mutable nextTime = nextAnalyseTime
                    let cycleSw = Stopwatch.StartNew()
                    let mutable errorMessage: string option = None

                    try
                        try
                            let shallowAnalyse = DateTime.Now < nextTime
                            let useShallowAnalyze = shallowAnalyse && (not force)
                            updateValidationRuntime (fun state ->
                                { state with
                                    inProgress = true
                                    inProgressFile = uri.LocalPath
                                    lastStartedAtUnixMs = nowUnixMs ()
                                    lastCycleFile = uri.LocalPath
                                    lastCycleShallow = useShallowAnalyze
                                    lastCycleEditAction = isEditAction
                                    lastError = None })
                            logDiag $"lint force: %b{force}, shallow: %b{useShallowAnalyze}"
                            do! lint uri useShallowAnalyze false isEditAction

                            if not useShallowAnalyze then
                                let didGlobalWork = delayedAnalyze force
                                logDiag "lint after delayed"
                                // Somehow get updated localisation errors after loccache is updated.
                                // Re-lint only when global caches actually changed.
                                if didGlobalWork then
                                    do! lint uri true false false  // re-lint after cache refresh is never an "edit"
                                nextTime <- DateTime.Now.Add(delayTime)
                                needsDeepAnalyse <- needsTypeRefresh || delayedLocUpdate
                            else
                                needsDeepAnalyse <- true
                        with e ->
                            errorMessage <- Some e.Message
                            logError $"uri %A{uri.LocalPath} \n exception %A{e}"
                    finally
                        cycleSw.Stop()
                        updateValidationRuntime (fun state ->
                            { state with
                                inProgress = false
                                inProgressFile = ""
                                lastCompletedAtUnixMs = nowUnixMs ()
                                lastCycleElapsedMs = int64 (cycleSw.Elapsed.TotalMilliseconds)
                                lastError = errorMessage })
                        agent.Post(WorkComplete(nextTime))
                } |> Async.StartAsTask

            let analyze (file: VersionedTextDocumentIdentifier) force isEditAction =
                //eprintfn "Analyze %s" (file.uri.ToString())
                analyzeTask file.uri force isEditAction |> ignore

            let rec loop (inprogress: bool) (state: Map<string, VersionedTextDocumentIdentifier * bool * bool>) =
                async {
                    updateValidationRuntime (fun runtime -> { runtime with queueDepth = state.Count })
                    let waitTimeMs =
                        if not inprogress && state.IsEmpty && needsDeepAnalyse then
                            // If the user is completely idle, cap the wait time to 2.5 seconds.
                            // This ensures phantom diagnostic errors clear quickly instead of lingering 
                            // for the full adaptive delayTime (up to 30s).
                            let remaining = int (nextAnalyseTime - DateTime.Now).TotalMilliseconds
                            Math.Max(500, Math.Min(2500, remaining))
                        else
                            -1

                    let! msgOpt = agent.TryReceive(waitTimeMs)

                    if state.Count > 0 then
                        logDiag $"queue length: %i{state.Count}"

                    match msgOpt, inprogress with
                    | Some (UpdateRequest(ur, force)), false ->
                        analyze ur force true  // UpdateRequest is always an edit action
                        return! loop true state
                    | Some (UpdateRequest(ur, force)), true ->
                        if Map.containsKey ur.uri.LocalPath state then
                            if
                                (Map.find ur.uri.LocalPath state)
                                |> (fun ({ VersionedTextDocumentIdentifier.version = v }, _, _) -> v < ur.version)
                            then
                                return! loop inprogress (state |> Map.add ur.uri.LocalPath (ur, force, true))
                            else
                                return! loop inprogress state
                        else
                            return! loop inprogress (state |> Map.add ur.uri.LocalPath (ur, force, true))
                    // DidOpen / DidFocus: deep lint without marking needsTypeRefresh
                    | Some (OpenRequest ur), false ->
                        analyze ur false false  // not an edit action
                        return! loop true state
                    | Some (OpenRequest ur), true ->
                        if not (Map.containsKey ur.uri.LocalPath state) then
                            return! loop inprogress (state |> Map.add ur.uri.LocalPath (ur, false, false))
                        else
                            return! loop inprogress state  // edit request already queued, skip open
                    | Some (WorkComplete time), _ ->
                        nextAnalyseTime <- time

                        if Map.isEmpty state then
                            return! loop false state
                        else
                            let key =
                                match lastFocusedFile with
                                | Some focused when Map.containsKey focused state -> focused
                                | _ ->
                                    state
                                    |> Map.toSeq
                                    |> Seq.map fst
                                    |> Seq.head

                            let next, force, isEdit = state.[key]
                            let newstate = state |> Map.remove key
                            analyze next force isEdit
                            return! loop true newstate
                    | None, false -> 
                        logDiag "Idle timeout: triggering background delayedAnalyze"
                        let didGlobalWork = delayedAnalyze false
                        needsDeepAnalyse <- needsTypeRefresh || delayedLocUpdate
                        nextAnalyseTime <- DateTime.Now.Add(delayTime)

                        if didGlobalWork then
                            for doc in docs.OpenFiles() do
                                let uri = Uri(doc.FullName)
                                do! lint uri true false false  // idle re-lint is never an edit

                        return! loop false state
                    | None, true ->
                        return! loop inprogress state
                }

            loop false Map.empty)

    /// Debounce agent for DidChangeTextDocument lintAgent.
    /// Waits 1.5 seconds of inactivity before forwarding the lint request.
    /// This prevents write-lock contention during rapid typing.
    let lintDebounceAgent =
        MailboxProcessor.Start(fun agent ->
            let rec loop (pending: Map<string, VersionedTextDocumentIdentifier * bool>) =
                async {
                    updateValidationRuntime (fun runtime -> { runtime with debounceQueueDepth = pending.Count })
                    // Wait up to 1500ms for a new message; if none, fire the pending lint
                    let! msgOpt = agent.TryReceive(1500)
                    match msgOpt with
                    | Some (UpdateRequest(ur, force)) ->
                        // New edit arrived reset the debounce timer
                        return! loop (pending |> Map.add ur.uri.LocalPath (ur, force))
                    | Some (OpenRequest ur) ->
                        // Open requests bypass debounce - forward immediately
                        lintAgent.Post(OpenRequest ur)
                        return! loop pending
                    | Some (WorkComplete _) ->
                        // Ignore WorkComplete messages in debounce agent
                        return! loop pending
                    | None ->
                        // Timeout: 1.5s of inactivity forward to lintAgent
                        if not pending.IsEmpty then
                            for _, (ur, force) in pending |> Map.toSeq do
                                lintAgent.Post(UpdateRequest(ur, force))
                            return! loop Map.empty
                        else
                            return! loop pending
                }
            loop Map.empty)

    let setupRulesCaches () =
        let sw = Stopwatch.StartNew()
        let finishRules status error =
            sw.Stop()
            updateLoadingRuntime (fun state ->
                { state with
                    inProgress = false
                    phase = "rules"
                    lastCompletedAtUnixMs = nowUnixMs ()
                    lastElapsedMs = int64 (sw.Elapsed.TotalMilliseconds)
                    lastRulesStatus = status
                    lastError = error })
        updateLoadingRuntime (fun state ->
            { state with
                inProgress = true
                phase = "rules"
                lastStartedAtUnixMs = nowUnixMs ()
                lastGame = activeGame.ToString()
                lastRulesStatus = "checking"
                lastError = None })
        match cachePath, remoteRepoPath, useManualRules with
        | Some cp, Some rp, false ->
            let stable = rulesChannel <> "latest"
            let mutable rulesStatus = "updating"
            let mutable rulesError: string option = None

            client.CustomNotification(
                "loadingBar",
                JsonValue.Record
                    [| "value", JsonValue.String(LangResources.loadingBar_UpdatingRules)
                       "enable", JsonValue.Boolean(true) |]
            )

            let rulesResult =
                try Some (initOrUpdateRules rp cp stable true)
                with e ->
                    rulesStatus <- "error"
                    rulesError <- Some e.Message
                    logError $"Failed to update CWTools rules: {e.Message}"
                    None

            match rulesResult with
            | Some (true, Some date) ->
                rulesStatus <- "updated"
                let text = String.Format(LangResources.rulesUpdated, activeGame, date)
                logInfo text
            | Some (false, Some _) ->
                rulesStatus <- "up_to_date"
                logInfo "CWTools rules are already up-to-date."
            | Some (false, None) ->
                let fallbackConfigs = getConfigFiles cachePath useManualRules manualRulesFolder bundledRulesPath
                if fallbackConfigs.Length > 0 then
                    rulesStatus <- "fallback"
                    let warningMsg =
                        uiText
                            (sprintf "Failed to update CWTools rules for %A from the remote repository. Using cached, bundled, or workspace rules instead. Run 'CWTools: Run Installation Health Check' if validation looks incomplete." activeGame)
                            (sprintf "Failed to update CWTools rules for %A from the remote repository. Using cached, bundled, or workspace rules instead. Run 'CWTools: Run Installation Health Check' if validation looks incomplete." activeGame)
                    logWarning warningMsg
                    client.ShowMessage(
                        { ``type`` = MessageType.Warning
                          message = warningMsg }
                    )
                else
                    rulesStatus <- "missing"
                    let errorMsg =
                        uiText
                            (sprintf "Failed to update or load CWTools rules for %A. No cached or bundled fallback rules were found at %s. Reinstall the VSIX or run the package script again, then run 'CWTools: Run Installation Health Check'." activeGame cp)
                            (sprintf "Failed to update or load CWTools rules for %A. No cached or bundled fallback rules were found at %s. Reinstall the VSIX or run the package script again, then run 'CWTools: Run Installation Health Check'." activeGame cp)
                    rulesError <- Some errorMsg
                    logError errorMsg
                    client.ShowMessage(
                        { ``type`` = MessageType.Error
                          message = errorMsg }
                    )
            | Some _ -> rulesStatus <- "unknown"
            | None -> ()

            finishRules rulesStatus rulesError

            client.CustomNotification(
                "loadingBar",
                JsonValue.Record [| "value", JsonValue.String(""); "enable", JsonValue.Boolean(false) |]
            )
        | _ -> finishRules "skipped" None

    /// Bump this when the serialized vanilla cache format or serializer inputs
    /// become incompatible with caches produced by older extension builds.
    let vanillaCacheSchemaVersion = 1

    let vanillaCacheMetadataPath (cacheFilePath: string) =
        cacheFilePath + ".meta.json"

    let vanillaCacheSchemaStamp game =
        sprintf "vanilla-cache:%A:v%d" game vanillaCacheSchemaVersion

    let privateJsonProperty name =
        function
        | JsonValue.Record properties ->
            properties
            |> Array.tryFind (fun (key, _) -> key = name)
            |> Option.map snd
        | _ -> None

    let isVanillaCacheSchemaCurrent cacheFilePath game =
        let metadataPath = vanillaCacheMetadataPath cacheFilePath
        if not (File.Exists metadataPath) then
            vanillaCacheSchemaVersion = 1
        else
            try
                let metadata = JsonValue.Load(metadataPath)
                match privateJsonProperty "schemaStamp" metadata, privateJsonProperty "schemaVersion" metadata with
                | Some (JsonValue.String stamp), _ ->
                    stamp = vanillaCacheSchemaStamp game
                | _, Some (JsonValue.Number version) ->
                    int version = vanillaCacheSchemaVersion
                | _ -> false
            with e ->
                logInfo (sprintf "Failed to read vanilla cache metadata %s: %A" metadataPath e)
                false

    let writeVanillaCacheMetadata cacheFilePath game vanillaPath =
        let metadataPath = vanillaCacheMetadataPath cacheFilePath
        let metadata =
            JsonValue.Record
                [| "schemaVersion", JsonValue.Number(decimal vanillaCacheSchemaVersion)
                   "schemaStamp", JsonValue.String(vanillaCacheSchemaStamp game)
                   "game", JsonValue.String(game.ToString())
                   "vanillaPath", JsonValue.String vanillaPath
                   "generatedAtUtc", JsonValue.String(DateTime.UtcNow.ToString("O")) |]
        File.WriteAllText(metadataPath, metadata.ToString(), Encoding.UTF8)

    let checkOrSetGameCache (forceCreate: bool) =
        let sw = Stopwatch.StartNew()
        let mutable cacheStatus = "skipped"
        let mutable cacheError: string option = None
        updateLoadingRuntime (fun state ->
            { state with
                inProgress = true
                phase = "vanilla_cache"
                lastStartedAtUnixMs = nowUnixMs ()
                lastGame = activeGame.ToString()
                lastCacheStatus = "checking"
                lastError = None })
        match (cachePath, isVanillaFolder, activeGame) with
        | _, _, Custom -> cacheStatus <- "skipped_custom_game"
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
                let cacheFilePath = gameCachePath + cacheFile + ".cwb"
                let doesCacheExist = File.Exists(cacheFilePath)

                let mutable isOutdated = false
                if doesCacheExist && not forceCreate then
                    if not (isVanillaCacheSchemaCurrent cacheFilePath activeGame) then
                        isOutdated <- true
                        logInfo (sprintf "Vanilla cache %s schema stamp is outdated. Current schema: %s" cacheFilePath (vanillaCacheSchemaStamp activeGame))

                    try
                        match vanillaPathOpt with
                        | Some vp ->
                            let cacheTime = File.GetLastWriteTimeUtc(cacheFilePath)
                            let parent = 
                                let p = System.IO.Directory.GetParent(vp)
                                if p <> null then p.FullName else vp
                            let checkPaths =
                                [ vp
                                  parent
                                  System.IO.Path.Combine(vp, "common")
                                  System.IO.Path.Combine(vp, "events")
                                  System.IO.Path.Combine(vp, "checksum_manifest.txt")
                                  System.IO.Path.Combine(parent, "checksum_manifest.txt")
                                  System.IO.Path.Combine(vp, "launcher-settings.json")
                                  System.IO.Path.Combine(parent, "launcher-settings.json") ]
                            let latestTime =
                                checkPaths
                                |> List.choose (fun p ->
                                    if File.Exists(p) then Some (File.GetLastWriteTimeUtc(p))
                                    elif System.IO.Directory.Exists(p) then Some (System.IO.Directory.GetLastWriteTimeUtc(p))
                                    else None)
                                |> function
                                    | [] -> System.DateTime.MinValue
                                    | times -> times |> List.max
                            if latestTime > cacheTime then
                                isOutdated <- true
                                logInfo (sprintf "Vanilla cache %s is outdated. Latest cache input update: %O, Cache time: %O" cacheFilePath latestTime cacheTime)
                        | None -> ()
                    with e -> 
                        logInfo (sprintf "Failed to check cache outdated status: %A" e)

                if doesCacheExist && not forceCreate && not isOutdated then
                    cacheStatus <- "up_to_date"
                    logInfo (sprintf "Cache exists and is up-to-date at %s" cacheFilePath)
                else
                    match vanillaPathOpt with
                    | Some vp ->
                        cacheStatus <- "generating"
                        client.CustomNotification(
                            "loadingBar",
                            JsonValue.Record
                                [| "value", JsonValue.String(LangResources.loadingBar_GeneratingVanillaCache)
                                   "enable", JsonValue.Boolean(true) |]
                        )

                        try
                            serializeFn vp gameCachePath
                            writeVanillaCacheMetadata cacheFilePath activeGame vp
                            cacheStatus <- "generated"
                            let text = String.Format(LangResources.vanillaCacheUpdated, activeGame)
                            client.CustomNotification("forceReload", JsonValue.String(text))
                        with e ->
                            cacheStatus <- "error"
                            let errorMsg = sprintf "Failed to generate vanilla cache for %A. Check permissions for %s. Error: %s" activeGame gameCachePath e.Message
                            cacheError <- Some errorMsg
                            logError errorMsg
                            client.ShowMessage(
                                { ``type`` = MessageType.Error // Error
                                  message = errorMsg }
                            )
                    | None ->
                        cacheStatus <- "prompted_vanilla_path"
                        client.CustomNotification("promptVanillaPath", JsonValue.String(promptName))
        | _ ->
            cacheStatus <- "no_cache_path"
            logInfo "No cache path"
        sw.Stop()
        updateLoadingRuntime (fun state ->
            { state with
                inProgress = false
                phase = "vanilla_cache"
                lastCompletedAtUnixMs = nowUnixMs ()
                lastElapsedMs = int64 (sw.Elapsed.TotalMilliseconds)
                lastCacheStatus = cacheStatus
                lastError = cacheError })

    /// Precache CodeLens for all files. InlayHints stay lazy because walking
    /// every entity after load can starve editor requests during file switches.
    let precacheAllFiles () =
        let sw = Stopwatch.StartNew()
        let mutable precacheFileCount = 0
        let mutable precacheError: string option = None
        updateLoadingRuntime (fun state ->
            { state with
                inProgress = true
                phase = "precache"
                lastStartedAtUnixMs = nowUnixMs ()
                lastGame = activeGame.ToString()
                lastError = None })
        match gameObj with
        | None ->
            sw.Stop()
            updateLoadingRuntime (fun state ->
                { state with
                    inProgress = false
                    phase = "precache"
                    lastCompletedAtUnixMs = nowUnixMs ()
                    lastElapsedMs = int64 (sw.Elapsed.TotalMilliseconds)
                    lastPrecacheFileCount = 0
                    lastError = None })
        | Some game ->
            client.CustomNotification(
                "loadingBar",
                JsonValue.Record [| "value", JsonValue.String(LangResources.loadingBar_PrecachingUI); "enable", JsonValue.Boolean(true) |]
            )
            try
                codeLensCache.Clear()

                // Build CodeLens cache from type index (no file reads, instant)
                let groupedTypes = getOrBuildGroupedTypes game
                precacheFileCount <- groupedTypes.Count
                for (filePath, items) in groupedTypes |> Map.toSeq do
                    let lenses =
                        items
                        |> List.map (fun (typeName, id, tdi) -> makeTypeCodeLens None typeName id filePath tdi)
                    cachePut codeLensCache filePath (codeLensPrecacheHash, lenses)

                // Warm the direct reference index during the loading/precache phase
                // so CodeLens clicks do not pay an all-project scan later.
                game.TypeReferenceIndex() |> ignore

            with e ->
                precacheError <- Some e.Message
                eprintfn $"Precache failed: %A{e}"
            client.CustomNotification(
                "loadingBar",
                JsonValue.Record [| "value", JsonValue.String(""); "enable", JsonValue.Boolean(false) |]
            )
            maybeCollectGarbage ()
            sw.Stop()
            updateLoadingRuntime (fun state ->
                { state with
                    inProgress = false
                    phase = "precache"
                    lastCompletedAtUnixMs = nowUnixMs ()
                    lastElapsedMs = int64 (sw.Elapsed.TotalMilliseconds)
                    lastPrecacheFileCount = precacheFileCount
                    lastError = precacheError })

    let processWorkspace (uri: option<Uri>) =
        let sw = Stopwatch.StartNew()
        let mutable loadedFileCount = 0
        let mutable parserErrorCount = 0
        let mutable validationErrorCount = 0
        let mutable localisationErrorCount = 0
        let mutable loadError: string option = None
        updateLoadingRuntime (fun state ->
            { state with
                inProgress = true
                phase = "loading_project"
                lastStartedAtUnixMs = nowUnixMs ()
                lastGame = activeGame.ToString()
                lastError = None })
        client.CustomNotification(
            "loadingBar",
            JsonValue.Record
                [| "value", JsonValue.String(LangResources.loadingBar_LoadingProject)
                   "enable", JsonValue.Boolean(true) |]
        )

        match uri with
        | Some u ->
            let path = getPathFromDoc u
            updateLoadingRuntime (fun state ->
                { state with
                    inProgress = true
                    phase = "loading_project"
                    lastWorkspaceRoot = path
                    lastGame = activeGame.ToString()
                    lastError = None })

            try
                let serverSettings =
                    { cachePath = cachePath
                      bundledRulesPath = bundledRulesPath
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

                // Before loading a new game, clean up the old game object references and release them
                let cleanupOldGame () =
                    match gameObj with
                    | Some oldGame ->
                        try
                            let existingFiles = docs.OpenFiles() |> List.map (fun f -> f.FullName) |> Set.ofList
                            oldGame.CleanupCache existingFiles
                        with e -> logDiag $"CleanupCache error on reload: {e.Message}"
                    | None -> ()
                    for kvp in fileDiagnosticStates |> Seq.toArray do
                        if kvp.Value.diagnostics.Length > 0 then
                            client.PublishDiagnostics { uri = diagnosticUri kvp.Key; diagnostics = [] }
                    // Clear all old type-specific references
                    gameFieldClearers |> List.iter (fun f -> f())
                    gameObj <- None
                    fileDiagnosticStates.Clear()
                    locCache.Clear()
                    cachedLocMap <- None
                    cachedLocMapCount <- 0
                    semanticTokensCache.Clear()
                    clearAllDerivedCaches ()
                    cacheWriteTimes.Clear()

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
                parserErrorCount <- parserErrors.Length

                let mapResourceToFilePath =
                    function
                    | EntityResource(f, r) -> r.scope, f, r.logicalpath
                    | FileResource(f, r) -> r.scope, f, r.logicalpath
                    | FileWithContentResource(f, r) -> r.scope, f, r.logicalpath

                let fileEntries =
                    game.AllFiles()
                    |> List.choose (fun resource ->
                        let scope, fileUri, logicalPath = mapResourceToFilePath resource

                        match Uri.TryCreate(fileUri, UriKind.Absolute) with
                        | TrySuccess url -> Some(scope, url, logicalPath)
                        | TryFailure -> None)

                let loadedFilePaths =
                    fileEntries
                    |> List.map (fun (_, uri, _) -> getPathFromDoc uri)
                    |> List.distinctBy normaliseCachePath

                let fileList =
                    fileEntries
                    |> List.map (fun (s, uri, l) ->
                        JsonValue.Record
                            [| "scope", JsonValue.String s
                               "uri", uri.AbsoluteUri |> JsonValue.String
                               "logicalpath", JsonValue.String l |])
                    |> Array.ofList
                loadedFileCount <- fileList.Length

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
                validationErrorCount <- valErrors.Length

                let locRaw = game.LocalisationErrors(true, true)
                localisationErrorCount <- locRaw.Length
                locCache.Clear()
                cachedLocMap <- None
                cachedLocMapCount <- 0
                for fileName, errors in locRaw |> List.groupBy _.range.FileName do
                    locCache.[fileName] <- errors

                let locErrors =
                    locRaw
                    |> List.map (fun e ->
                        (e.code, e.severity, e.range.FileName, e.message, e.range, e.keyLength, e.relatedErrors))

                let visibleInitialDiagnostics =
                    parserErrors @ valErrors @ locErrors
                    |> List.map parserErrorToDiagnostics
                    |> List.filter diagnosticFilter

                visibleInitialDiagnostics |> sendDiagnostics

                let diagnosticsByFile =
                    visibleInitialDiagnostics
                    |> List.groupBy (fun (filePath, _) -> normaliseCachePath filePath)
                    |> Map.ofList

                let loadedNormalised = loadedFilePaths |> List.map normaliseCachePath |> Set.ofList
                let loadEpoch = nextDiagnosticEpoch ()

                for filePath in loadedFilePaths do
                    let diagnostics =
                        diagnosticsByFile
                        |> Map.tryFind (normaliseCachePath filePath)
                        |> Option.map (List.map snd)
                        |> Option.defaultValue []
                    setFileDiagnosticStateWithEpoch filePath loadEpoch Fresh [] diagnostics

                diagnosticsByFile
                |> Map.toSeq
                |> Seq.iter (fun (_, entries) ->
                    match entries with
                    | (filePath, _) :: _ when not (loadedNormalised.Contains(normaliseCachePath filePath)) ->
                        setFileDiagnosticStateWithEpoch filePath loadEpoch Fresh [] (entries |> List.map snd)
                    | _ -> ())

                // L6 Fix: non-blocking optimised GC avoids a 100ms freeze on load
                maybeCollectGarbage ()
            with e ->
                loadError <- Some e.Message
                eprintfn $"%A{e}"

        | None -> ()

        sw.Stop()
        let finalPhase =
            match loadError, uri, gameObj with
            | Some _, _, _ -> "load_project_error"
            | None, None, _ -> "no_workspace"
            | None, Some _, Some _ -> "ready"
            | None, Some _, None -> "not_loaded"
        updateLoadingRuntime (fun state ->
            { state with
                inProgress = false
                phase = finalPhase
                lastCompletedAtUnixMs = nowUnixMs ()
                lastElapsedMs = int64 (sw.Elapsed.TotalMilliseconds)
                lastFileCount = loadedFileCount
                lastParserErrorCount = parserErrorCount
                lastValidationErrorCount = validationErrorCount
                lastLocalisationErrorCount = localisationErrorCount
                lastError = loadError })

        client.CustomNotification(
            "loadingBar",
            JsonValue.Record [| "value", JsonValue.String(""); "enable", JsonValue.Boolean(false) |]
        )

        // Notify AI agent that the server is fully ready (game data loaded and validated)
        match loadError, gameObj with
        | None, Some _ ->
            client.CustomNotification(
                "cwtools/serverReady",
                JsonValue.Record
                    [| "game", JsonValue.String(activeGame.ToString())
                       "vanillaLoaded", JsonValue.Boolean(not isVanillaFolder)
                       "timestamp", JsonValue.Number(decimal (System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())) |]
            )
        | _ -> ()

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

                    match opt.Item("uiLanguage") with
                    | JsonValue.String x -> uiLanguage <- x
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

                    match opt.Item("bundledRulesPath") with
                    | JsonValue.String x when not (String.IsNullOrWhiteSpace x) ->
                        logInfo $"bundled rules path %A{x}"
                        bundledRulesPath <- Some x
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
                                    change = TextDocumentSyncKind.Incremental }
                            completionProvider =
                                Some defaultCompletionOptions
                            codeActionProvider = true
                            codeLensProvider = Some { resolveProvider = false }
                            documentLinkProvider = Some defaultDocumentLinkOptions
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
                                          "cwtools.findTypeReferences"
                                          // A2 Fix: declare ALL implemented AI commands so
                                          // strict LSP clients don't reject them.
                                          "cwtools.ai.getScopeAtPosition"
                                          "cwtools.ai.getCompletionContext"
                                          "cwtools.ai.queryTypes"
                                          "cwtools.ai.queryDefinition"
                                          "cwtools.ai.queryDefinitionByName"
                                          "cwtools.ai.queryScriptedEffects"
                                          "cwtools.ai.queryScriptedTriggers"
                                          "cwtools.ai.queryEnums"
                                          "cwtools.ai.getEntityInfo"
                                          "cwtools.ai.queryStaticModifiers"
                                          "cwtools.ai.queryVariables"
                                          "cwtools.ai.getDiagnosticsFresh"
                                          "cwtools.ai.waitDiagnosticsFresh"
                                          "cwtools.ai.getValidationStatus"
                                          "cwtools.ai.parseFragment"
                                          "cwtools.exportTypes"
                                          "getFileTypes" ] }
                            inlayHintProvider = true
                            renameProvider = true
                            semanticTokensProvider =
                                Some
                                    { legend =
                                        { tokenTypes =
                                            [ "namespace"; "type"; "function"; "variable"; "parameter"
                                              "property"; "enumMember"; "keyword"; "number"; "string"
                                              "comment"; "operator"; "macro"; "decorator" ]
                                          tokenModifiers = [ "declaration"; "definition"; "readonly" ] }
                                      full = true
                                      range = false
                                      delta = true } } }
            }

        member this.Initialized() = async { () }
        member this.Shutdown() = async { return None }

        member this.DidChangeConfiguration(p: DidChangeConfigurationParams) =
            async {
                let config = p.settings.Item("cwtools")

                let newLanguages =
                    match langConfigMap |> List.tryFind (fun (g, _, _) -> g = activeGame) with
                    | Some (_, parse, defaultFn) ->
                        match config.Item("localisation").Item("languages") with
                        | JsonValue.Array o ->
                            o
                            |> Array.choose (function JsonValue.String s -> Some (parse s) | _ -> None)
                            |> fun l -> if Array.isEmpty l then defaultFn() else l
                        | _ -> defaultFn()
                    | None -> [| Lang.Custom CustomLang.English |]

                let mutable requiresReload = false
                let updateIfChanged current newVal =
                    if current <> newVal then
                        requiresReload <- true
                        newVal
                    else current

                if languages <> newLanguages then
                    languages <- newLanguages
                    requiresReload <- true

                match config.Item("localisation").Item("generated_strings") with
                | JsonValue.String newString -> generatedStrings <- updateIfChanged generatedStrings newString
                | _ -> ()

                let newVanillaOnly =
                    match config.Item("errors").Item("vanilla") with
                    | JsonValue.Boolean b -> b
                    | _ -> validateVanilla

                validateVanilla <- updateIfChanged validateVanilla newVanillaOnly

                match config.Item("experimental") with
                | JsonValue.Boolean b -> experimental <- b
                | _ -> ()

                match config.Item("debug_mode") with
                | JsonValue.Boolean b -> debugMode <- b
                | _ -> ()

                let newIgnoreCodes =
                    match config.Item("errors").Item("ignore") with
                    | JsonValue.Array o ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s -> Some s
                            | _ -> None)
                    | _ -> ignoreCodes

                if ignoreCodes <> newIgnoreCodes then
                    ignoreCodes <- newIgnoreCodes
                    requiresReload <- true

                let newIgnoreFiles =
                    match config.Item("errors").Item("ignorefiles") with
                    | JsonValue.Array o ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s -> Some s
                            | _ -> None)
                    | _ -> ignoreFiles

                if ignoreFiles <> newIgnoreFiles then
                    ignoreFiles <- newIgnoreFiles
                    requiresReload <- true

                let excludePatterns =
                    match config.Item("ignore_patterns") with
                    | JsonValue.Array o ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s -> Some s
                            | _ -> None)
                    | _ -> dontLoadPatterns

                if dontLoadPatterns <> excludePatterns then
                    dontLoadPatterns <- excludePatterns
                    requiresReload <- true

                match config.Item("trace").Item("server") with
                | JsonValue.String "messages"
                | JsonValue.String "verbose" -> loglevel <- LogLevel.Verbose
                | _ -> ()

                for (configKey, getter, setter) in vanillaPathMap do
                    match config.Item("cache").Item(configKey) with
                    | JsonValue.String "" -> ()
                    | JsonValue.String s -> 
                        let old = getter () |> Option.defaultValue ""
                        if old <> s then
                            setter (Some s)
                            requiresReload <- true
                    | _ -> ()


                match config.Item("rules_folder") with
                | JsonValue.String x -> 
                    let old = manualRulesFolder |> Option.defaultValue ""
                    if old <> x then
                        manualRulesFolder <- Some x
                        requiresReload <- true
                | _ -> ()

                match config.Item("showInlineText") with
                | JsonValue.Boolean x -> showInlineText <- x
                | _ -> ()

                match config.Item("maxFileSize") with
                | JsonValue.Number x -> maxFileSize <- int x
                | _ -> ()

                logInfo $"New configuration %s{p.ToString()} - requiresReload: %b{requiresReload}"

                match cachePath with
                | Some dir ->
                    if Directory.Exists dir then
                        ()
                    else
                        Directory.CreateDirectory dir |> ignore
                | _ -> ()

                if requiresReload then
                    let task =
                        new Task(fun () ->
                            // Phase 1: game init / swap (needs write lock)
                            gameStateLock.EnterWriteLock()
                            try
                                setupRulesCaches ()
                                checkOrSetGameCache false
                                processWorkspace rootUri
                            finally
                                gameStateLock.ExitWriteLock()
                            // Phase 2: precache (no lock needed - reads game data, writes ConcurrentDictionary)
                            precacheAllFiles ())

                    task.Start()
            }

        member this.DidOpenTextDocument(p: DidOpenTextDocumentParams) =
            async {
                docs.Open p

                lintAgent.Post(
                    OpenRequest(
                        { uri = p.textDocument.uri
                          version = p.textDocument.version }
                    )
                )

                let mapResourceToFilePath =
                    function
                    | EntityResource(f, r) -> r.scope, f, r.logicalpath
                    | FileResource(f, r) -> r.scope, f, r.logicalpath
                    | FileWithContentResource(f, r) -> r.scope, f, r.logicalpath

                match gameObj with
                | Some game when System.Threading.Interlocked.CompareExchange(currentlyRefreshingFiles, 1, 0) = 0 ->

                    let task =
                        new Task(fun () ->
                            // M1 Fix: AllFiles() reads internal game state acquire a shared
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
                                System.Threading.Interlocked.Exchange(currentlyRefreshingFiles, 0) |> ignore)

                    task.Start()
                | _ -> ()
            }

        member this.DidFocusFile(p: DidFocusFileParams) =
            async {
                let path = getPathFromDoc p.uri
                lastFocusedFile <- Some path
                lintAgent.Post(OpenRequest({ uri = p.uri; version = 0 }))
            }

        member this.DidChangeTextDocument(p: DidChangeTextDocumentParams) =
            async {
                docs.Change p
                let path = getPathFromDoc p.textDocument.uri
                forgetFileCaches path
                // Clear the deep validation cache for this file to ensure that shallow lint does not return the old errors before the fix
                match gameObj with
                | Some game -> game.InvalidateFileCache path
                | None -> ()
                markFileStale path "edit"

                // Use debounce agent instead of immediate lint.
                // Lint will fire after 1.5s of typing inactivity.
                // This prevents the write lock (game.UpdateFile) from blocking
                // read requests (Completion, Hover, SemanticTokens) during rapid typing.
                lintDebounceAgent.Post(
                    UpdateRequest(
                        { uri = p.textDocument.uri
                          version = p.textDocument.version },
                        false  // Let the lint agent use shallow passes while typing; save/focus still forces deep lint.
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

        // P0 Fix: was TODO() return empty edit list instead of crashing
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

        member this.DidCloseTextDocument(p: DidCloseTextDocumentParams) = async { 
            docs.Close p 
            let localPath = p.textDocument.uri.LocalPath
            let fullPath = try FileInfo(localPath).FullName with _ -> localPath
            // Clean all file-level caches to prevent memory leaks from closed files
            forgetFileCaches localPath
            forgetFileCaches fullPath
            (locCache :> System.Collections.Generic.IDictionary<_, _>).Remove(localPath) |> ignore
            clearRangeCache ()
        }

        member this.DidChangeWatchedFiles(p: DidChangeWatchedFilesParams) =
            async {
                for change in p.changes do
                    match change.``type`` with
                    | FileChangeType.Created -> lintAgent.Post(UpdateRequest({ uri = change.uri; version = 0 }, true))
                    | FileChangeType.Deleted ->
                        let path = getPathFromDoc change.uri
                        client.PublishDiagnostics { uri = change.uri; diagnostics = [] }
                        forgetFileCaches path
                        fileDiagnosticStates.TryRemove(path) |> ignore
                    | _ -> ()
            }

        member this.Completion(p: CompletionParams) =
            async {
                let sw = Stopwatch.StartNew()
                let allocBefore = GC.GetTotalAllocatedBytes(false)
                let filePath = getPathFromDoc p.textDocument.uri
                updateCompletionRuntime (fun state ->
                    { state with
                        lastStartedAtUnixMs = nowUnixMs ()
                        lastFile = filePath
                        lastLine = p.position.line
                        lastCharacter = p.position.character
                        lastError = None })
                let fileText = docs.GetText(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue ""
                let hash = contentHash fileText
                let cacheKey = completionListCacheKey filePath hash p.position.line p.position.character debugMode clientSupportsInsertReplaceEdit
                let now = DateTime.UtcNow
                match completionListCache.TryGetValue(cacheKey) with
                | true, (createdAt, cached) when (now - createdAt).TotalMilliseconds <= completionListTtlMs ->
                    sw.Stop()
                    let allocAfter = GC.GetTotalAllocatedBytes(false)
                    let count = cached |> Option.map (fun r -> r.items.Length) |> Option.defaultValue 0
                    let isIncomplete = cached |> Option.map (fun r -> r.isIncomplete) |> Option.defaultValue false
                    updateCompletionRuntime (fun state ->
                        { state with
                            totalRequests = state.totalRequests + 1
                            cacheHits = state.cacheHits + 1
                            lastCompletedAtUnixMs = nowUnixMs ()
                            lastElapsedMs = int64 sw.ElapsedMilliseconds
                            lastItemCount = count
                            lastCacheHit = true
                            lastIsIncomplete = isIncomplete
                            lastError = None })
                    monitorLog Completion $"Completion ttl-hit file={filePath} line={p.position.line} char={p.position.character} elapsed={sw.ElapsedMilliseconds}ms allocDeltaMB={(allocAfter - allocBefore) / 1048576L}{getPerfCacheSnapshot()}"
                    perfCompletionCount <- perfCompletionCount + 1
                    maybePerfReport "completion-cache-hit"
                    return cached
                | _ ->
                    let result = completion gameObj p docs debugMode clientSupportsInsertReplaceEdit
                    completionListCache.[cacheKey] <- (now, result)
                    evictCompletionListCacheIfNeeded ()
                    sw.Stop()
                    let allocAfter = GC.GetTotalAllocatedBytes(false)
                    let count = result |> Option.map (fun r -> r.items.Length) |> Option.defaultValue 0
                    let isIncomplete = result |> Option.map (fun r -> r.isIncomplete) |> Option.defaultValue false
                    updateCompletionRuntime (fun state ->
                        { state with
                            totalRequests = state.totalRequests + 1
                            cacheMisses = state.cacheMisses + 1
                            lastCompletedAtUnixMs = nowUnixMs ()
                            lastElapsedMs = int64 sw.ElapsedMilliseconds
                            lastItemCount = count
                            lastCacheHit = false
                            lastIsIncomplete = isIncomplete
                            lastError = None })
                    monitorLog Completion $"Completion file={filePath} line={p.position.line} char={p.position.character} items={count} elapsed={sw.ElapsedMilliseconds}ms allocDeltaMB={(allocAfter - allocBefore) / 1048576L}{getPerfCacheSnapshot()}"
                    perfCompletionCount <- perfCompletionCount + 1
                    maybePerfReport "completion"
                    return result
            }
            |> catchError None

        member this.Hover(p: TextDocumentPositionParams) =
            async {
                let sw = Stopwatch.StartNew()
                let allocBefore = GC.GetTotalAllocatedBytes(false)
                let filePath = getPathFromDoc p.textDocument.uri
                // Build or reuse cached locMap for hover
                let locMapForHover =
                    match cachedLocMap with
                    | Some m -> m
                    | None ->
                        let mutable result = []
                        let builder = { new IGameVisitor<int> with
                            member _.Visit(game: IGame<_>) =
                                result <- getOrBuildLocMap game
                                0 }
                        gameDispatcher.Dispatch builder |> ignore
                        result
                let! hover =
                    hoverDocument
                        gameDispatcher
                        docs
                        p.textDocument.uri
                        p.position
                        locMapForHover
                sw.Stop()
                let allocAfter = GC.GetTotalAllocatedBytes(false)
                let allocDelta = allocAfter - allocBefore
                if sw.ElapsedMilliseconds >= 25L || allocDelta >= 8L * 1024L * 1024L then
                    monitorLog Hover $"Hover file={filePath} line={p.position.line} char={p.position.character} elapsed={sw.ElapsedMilliseconds}ms allocDeltaMB={allocDelta / 1048576L} cachedLocKeys={cachedLocMapCount}{getPerfCacheSnapshot()}"
                return Some hover
            }
            |> catchError None

        member this.ResolveCompletionItem(p: CompletionItem) =
            async { return! completionResolveItem gameObj p }
            |> catchError p

        member this.SignatureHelp(p: TextDocumentPositionParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let allEffects = game.ScriptedEffects() @ game.ScriptedTriggers()
                        let effectNames = allEffects |> Seq.map (fun e -> e.Name.GetString()) |> System.Collections.Generic.HashSet

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
                                        if parts.Length > 0 && effectNames.Contains(parts.[0]) then
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
                                let paramRegex = scriptedParamRegex

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
                let sw = Stopwatch.StartNew()
                let allocBefore = GC.GetTotalAllocatedBytes(false)
                let result =
                    match gameObj with
                    | Some game ->
                        let position = PosHelper.fromZ p.position.line p.position.character
                        let path = getPathFromDoc p.textDocument.uri
                        let fileContent =
                            docs.GetText(FileInfo(path))
                            |> Option.defaultValue (try File.ReadAllText path with _ -> "")

                        let gototype =
                            game.GoToType
                                position
                                path
                                fileContent
                            |> preferCodeDefinitionOverLocalisation
                                gameDispatcher
                                game
                                path
                                fileContent
                                p.position.line
                                p.position.character

                        match gototype with
                        | Some goto ->
                            [ { uri = Uri(goto.FileName)
                                range = (convRangeToLSPRange goto) } ]
                        | None -> []
                    | None -> []
                sw.Stop()
                let allocAfter = GC.GetTotalAllocatedBytes(false)
                if sw.ElapsedMilliseconds >= 50L then
                    monitorLog Performance $"GotoDefinition file={getPathFromDoc p.textDocument.uri} line={p.position.line} char={p.position.character} elapsed={sw.ElapsedMilliseconds}ms allocDeltaMB={(allocAfter - allocBefore) / 1048576L}{getPerfCacheSnapshot()}"
                return result
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

        member this.DocumentHighlight(p: TextDocumentPositionParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let position = PosHelper.fromZ p.position.line p.position.character
                        let path = getPathFromDoc p.textDocument.uri
                        let currentUri = p.textDocument.uri

                        let refs =
                            game.FindAllRefs
                                position
                                path
                                (docs.GetText(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue "")

                        match refs with
                        | Some locations ->
                            locations
                            |> List.filter (fun loc -> loc.FileName = currentUri.LocalPath)
                            |> List.map (fun loc ->
                                { range = convRangeToLSPRange loc
                                  kind = DocumentHighlightKind.Read })
                        | None -> []
                    | None -> []
            }
            |> catchError []

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
                        let filePath = p.textDocument.uri.LocalPath

                        if PdxShaderFeatures.isShaderFile filePath then
                            let text = docs.GetText(FileInfo(filePath)) |> Option.defaultValue ""

                            let shaderSymbolKind =
                                function
                                | PdxShaderFeatures.IncludesSymbol
                                | PdxShaderFeatures.SamplersSymbol
                                | PdxShaderFeatures.CodeBlockSymbol -> SymbolKind.Namespace
                                | PdxShaderFeatures.IncludeFileSymbol -> SymbolKind.File
                                | PdxShaderFeatures.VertexStructSymbol
                                | PdxShaderFeatures.ConstantBufferSymbol -> SymbolKind.Class
                                | PdxShaderFeatures.ShaderBlockSymbol -> SymbolKind.Module
                                | PdxShaderFeatures.MainCodeSymbol -> SymbolKind.Function
                                | PdxShaderFeatures.EffectSymbol -> SymbolKind.Method
                                | PdxShaderFeatures.BlendStateSymbol
                                | PdxShaderFeatures.DepthStencilStateSymbol
                                | PdxShaderFeatures.RasterizerStateSymbol -> SymbolKind.Interface
                                | PdxShaderFeatures.SamplerSymbol -> SymbolKind.Field

                            let rec shaderDocumentSymbol (item: PdxShaderFeatures.ShaderDocumentSymbol) =
                                { name = item.name
                                  detail = item.detail
                                  kind = shaderSymbolKind item.kind
                                  deprecated = false
                                  range = convRangeToLSPRange item.range
                                  selectionRange = convRangeToLSPRange item.selectionRange
                                  children = item.children |> List.map shaderDocumentSymbol }

                            PdxShaderFeatures.documentSymbols filePath text
                            |> List.map shaderDocumentSymbol
                        else
                            let types = game.Types()

                            let (all: DocumentSymbol seq) =
                                types
                                |> Map.toList
                                |> Seq.collect (fun (k, vs) ->
                                    vs
                                    |> Seq.filter (fun tdi -> tdi.range.FileName = filePath)
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
                        let filePath = FileInfo(p.textDocument.uri.LocalPath).FullName
                        let readFileText () =
                            match docs.GetTextByPath(filePath) with
                            | Some t -> t
                            | None -> try System.IO.File.ReadAllText(filePath) with _ -> ""
                        let buildLenses fileText =
                            let hash = contentHash fileText
                            // Use cached type index for O(1) lookup per file
                            let grouped = getOrBuildGroupedTypes game
                            let lenses =
                                match grouped.TryFind(filePath) with
                                | Some items ->
                                    items
                                    |> List.map (fun (typeName, id, tdi) -> makeTypeCodeLens (Some fileText) typeName id filePath tdi)
                                | None -> []
                            cachePut codeLensCache filePath (hash, lenses)
                            evictIfNeeded codeLensCache
                            lenses
                        match codeLensCache.TryGetValue(filePath) with
                        | true, (cachedHash, cachedLenses) when cachedHash = codeLensPrecacheHash ->
                            readFileText () |> buildLenses
                        | true, (cachedHash, cachedLenses) ->
                            let fileText = readFileText ()
                            let hash = contentHash fileText
                            if cachedHash = hash then cachedLenses else buildLenses fileText
                        | _ ->
                            readFileText () |> buildLenses
                    | None -> []
            }
            |> catchError []

        member this.ResolveCodeLens(p: CodeLens) =
            async {
                return
                    match gameObj with
                    | Some _ ->
                        try
                            let typeName = p.data.Item("typeName").AsString()
                            let id = p.data.Item("id").AsString()
                            let filePath = p.data.Item("filePath").AsString()
                            let line = p.data.Item("line").AsInteger()
                            let character = p.data.Item("character").AsInteger()
                            let fileText =
                                match docs.GetTextByPath(filePath) with
                                | Some t -> Some t
                                | None -> try Some(System.IO.File.ReadAllText(filePath)) with _ -> None
                            let typeName =
                                if looksLikePath typeName && not (looksLikePath id) then id else typeName
                            let id =
                                match tryDefinitionKeyAtLine fileText line with
                                | Some key when key <> typeName -> key
                                | _ -> id
                            let title = $"%s{typeName}: %s{id}"

                            { p with
                                command =
                                    Some
                                        { title = title
                                          command = "cwtools.showTypeReferences"
                                          arguments =
                                            [ JsonValue.String(Uri(filePath).ToString())
                                              codeLensPositionJson line character
                                              JsonValue.String typeName
                                              JsonValue.String id ] } }
                        with _ -> p
                    | None -> p
            }
            |> catchError p

        member this.InlayHint(p: InlayHintParams) =
            async {
                if not showInlineText then return []
                else
                    let filePath = FileInfo(p.textDocument.uri.LocalPath).FullName
                    // Match the hash correctly
                    let fileText = 
                        match docs.GetTextByPath(filePath) with
                        | Some t -> t
                        | None -> try System.IO.File.ReadAllText(filePath) with _ -> ""
                    let hash = contentHash fileText
                    
                    match inlayHintCache.TryGetValue(filePath) with
                    | true, (cachedHash, cachedHints) when cachedHash = hash -> return cachedHints
                    | _ ->
                        let inlayHintFunction (game: IGame<_>) =
                            let entityOpt = 
                                game.AllEntities() 
                                |> Seq.tryPick (fun struct (e, _) -> if FileInfo(e.filepath).FullName = filePath then Some e else None)
                            
                            match entityOpt with
                            | None -> []
                            | Some entity ->
                                let locMap = getOrBuildLocMap game |> Map.ofList
                                let hints = ResizeArray<InlayHint>()
                                let targetPath = entity.filepath
        
                                // Build scripted variable lookup map
                                let globalVars = game.ScriptedVariables()
                                let fileContent = fileText
                                let localVarPattern = inlayLocalVarPattern
                                let localVars =
                                    [ for m in localVarPattern.Matches(fileContent) ->
                                        m.Groups.[1].Value.Trim(), m.Groups.[2].Value.Trim() ]
                                let varMap = (localVars @ globalVars) |> Map.ofList
                                
                                let rec resolveLocRefs (text: string) (depth: int) =
                                    if depth > 3 then text
                                    else
                                        let pattern = System.Text.RegularExpressions.Regex(@"\$([a-zA-Z0-9_.]+)(?:\|[a-zA-Z0-9_.]+)?\$")
                                        let matches = pattern.Matches(text)
                                        if matches.Count = 0 then text
                                        else
                                            let mutable result = text
                                            let mutable changed = false
                                            for m in matches do
                                                let key = m.Groups.[1].Value
                                                match Map.tryFind key locMap with
                                                | Some tr -> 
                                                    let cleanTr = if tr.desc.StartsWith("\"") && tr.desc.EndsWith("\"") then tr.desc.Substring(1, tr.desc.Length - 2) else tr.desc
                                                    result <- result.Replace(m.Value, cleanTr)
                                                    changed <- true
                                                | None -> ()
                                            if changed then resolveLocRefs result (depth + 1) else result

                                let formatHintLabel (desc: string) =
                                    let clean = desc.Replace("\r\n", " ").Replace("\n", " ").Replace("\\n", " ").Trim()
                                    let clean = if clean.StartsWith("\"") && clean.EndsWith("\"") then clean.Substring(1, clean.Length - 2) else clean
                                    let clean = resolveLocRefs clean 0
                                    // Strip Paradox color codes
                                    let clean = paradoxColorPattern.Replace(clean, "")
                                    let truncated = if clean.Length > 50 then clean.Substring(0, 50) + "..." else clean
                                    sprintf "Loc:%s" truncated
        
                                let fileLines = fileText.Split([|"\r\n"; "\n"|], StringSplitOptions.None)
                                let getRealEndPos (startPos: LSP.Types.Position) (endPos: LSP.Types.Position) =
                                    let mutable l = min endPos.line (fileLines.Length - 1)
                                    let mutable c = endPos.character
                                    if l >= 0 && c >= fileLines.[l].Length then
                                        c <- fileLines.[l].Length
                                    let mutable found = false
                                    while l >= startPos.line && not found do
                                        if c > 0 && not (Char.IsWhiteSpace(fileLines.[l].[c - 1])) then
                                            found <- true
                                        else if c > 0 then
                                            c <- c - 1
                                        else if l > startPos.line then
                                            l <- l - 1
                                            if l >= 0 then c <- fileLines.[l].Length else found <- true
                                        else
                                            found <- true
                                    let fixedPos : LSP.Types.Position = { line = l; character = c }
                                    fixedPos

                                let tryAddVarHint (rawVal: string) (position: CWTools.Utilities.Position.range) =
                                    if rawVal.StartsWith("@[") && rawVal.EndsWith("]") then
                                        let expr = rawVal.Substring(2, rawVal.Length - 3)
                                        let varPattern = System.Text.RegularExpressions.Regex(@"[a-zA-Z_][a-zA-Z0-9_]*")
                                        let mutable finalExpr = expr
                                        let mutable allFound = true
                                        for m in varPattern.Matches(expr) do
                                            let varName = m.Value
                                            let key = if varName.StartsWith("@") then varName else "@" + varName
                                            match Map.tryFind key varMap with
                                            | Some v -> 
                                                // Only replace whole word matches to prevent partial replacements
                                                let wordPattern = System.Text.RegularExpressions.Regex(@"\b" + System.Text.RegularExpressions.Regex.Escape(varName) + @"\b")
                                                finalExpr <- wordPattern.Replace(finalExpr, v)
                                            | None ->
                                                allFound <- false
                                                
                                        if allFound then
                                            try
                                                use table = new System.Data.DataTable()
                                                let result = table.Compute(finalExpr, null)
                                                let range = convRangeToLSPRange position
                                                hints.Add {
                                                    position = getRealEndPos range.start range.``end``
                                                    label = sprintf "= %O" result
                                                    paddingLeft = true
                                                    paddingRight = true
                                                }
                                            with _ -> ()
                                            
                                    elif rawVal.StartsWith("@") then
                                        match Map.tryFind rawVal varMap with
                                        | Some value ->
                                            let range = convRangeToLSPRange position
                                            hints.Add {
                                                position = getRealEndPos range.start range.``end``
                                                label = sprintf "= %s" value
                                                paddingLeft = true
                                                paddingRight = true
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
                                                    position = getRealEndPos range.start range.``end``
                                                    label = formatHintLabel tr.desc
                                                    paddingLeft = true
                                                    paddingRight = true
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
                                                    position = getRealEndPos range.start range.``end``
                                                    label = formatHintLabel tr.desc
                                                    paddingLeft = true
                                                    paddingRight = true
                                                }
                                            | None -> ()
                                            tryAddVarHint rawVal lv.Position
                                    )
                                    n.Nodes |> Seq.iter visitNode
        
                                visitNode entity.entity
                                
                                hints 
                                |> Seq.distinctBy (fun h -> h.position.line, h.label)
                                |> Seq.toList
                            
                        let visitor = 
                            { new IGameVisitor<_> with 
                                member this.Visit game = inlayHintFunction game 
                            }
                        
                        let generatedHints = gameDispatcher.Dispatch visitor |> Option.defaultValue []
                        cachePut inlayHintCache filePath (hash, generatedHints)
                        evictIfNeeded inlayHintCache
                        return generatedHints
            }
            |> catchError []
        member this.DocumentLink(p: DocumentLinkParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let filePath = p.textDocument.uri.LocalPath
                        let text = docs.GetText(FileInfo(filePath)) |> Option.defaultValue ""

                        if PdxShaderFeatures.isShaderFile filePath then
                            PdxShaderFeatures.documentLinks (game.AllFiles()) filePath text
                            |> List.map (fun link ->
                                { range = convRangeToLSPRange link.range
                                  target = Some(Uri(link.targetFilepath)) })
                        else
                            let workspaceRoot =
                                workspaceFolders
                                |> List.tryHead
                                |> Option.map (fun f -> f.uri.LocalPath)
                                |> Option.defaultValue ""

                            // Match quoted strings that look like file paths (contain / and common extensions)
                            let pathRegex =
                                System.Text.RegularExpressions.Regex(
                                    @"""([^""]+\.(?:dds|tga|png|gfx|gui|txt|yml|asset|sfx))""",
                                    System.Text.RegularExpressions.RegexOptions.IgnoreCase)

                            let getLineCol (offset: int) =
                                let mutable line = 0
                                let mutable col = 0
                                for i = 0 to min (offset - 1) (text.Length - 1) do
                                    if text.[i] = '\n' || (text.[i] = '\r' && i + 1 < text.Length && text.[i + 1] = '\n') then
                                        if text.[i] = '\r' then () // skip \r in \r\n
                                        else line <- line + 1; col <- 0
                                    else col <- col + 1
                                (line, col)

                            pathRegex.Matches(text)
                            |> Seq.cast<System.Text.RegularExpressions.Match>
                            |> Seq.choose (fun m ->
                                let relativePath = m.Groups.[1].Value
                                let fullPath = System.IO.Path.Combine(workspaceRoot, relativePath.Replace('/', System.IO.Path.DirectorySeparatorChar))
                                if System.IO.File.Exists(fullPath) then
                                    let startOffset = m.Groups.[1].Index
                                    let endOffset = startOffset + m.Groups.[1].Length
                                    let (sl, sc) = getLineCol startOffset
                                    let (el, ec) = getLineCol endOffset
                                    Some {
                                        range = { ``start`` = { line = sl; character = sc }; ``end`` = { line = el; character = ec } }
                                        target = Some (Uri(fullPath))
                                    }
                                else None)
                            |> List.ofSeq
                    | None -> []
            }
            |> catchError []

        member this.ResolveDocumentLink(link: DocumentLink) = async { return link }

        member this.SemanticTokensFull(p: SemanticTokensParams) =
            // Token type indices (must match legend in capabilities):
            async {
                let semanticTokensFunction (game: IGame<_>) =
                    // - Content-hash cache: skip full AST traversal if file unchanged -
                    let filePath = p.textDocument.uri.LocalPath
                    let fileText = docs.GetText(FileInfo(filePath)) |> Option.defaultValue ""
                    let hash = contentHash fileText
                    match semanticTokensCache.TryGetValue(filePath) with
                    | true, (cachedHash, cachedData, cachedResultId) when cachedHash = hash ->
                        Some { data = Array.toList cachedData; resultId = Some cachedResultId }
                    | true, _ ->
                        // File modified! We want to cancel semantic updates until it is reopened.
                        // Returning None translates to [[CANCEL]] error so VS Code shifts tokens natively.
                        None
                    | false, _ ->
                        let dataArray = computeTokensForFile game filePath fileText
                        if dataArray.Length = 0 then
                            None
                        else
                            let resultId = Guid.NewGuid().ToString()
                            cachePut semanticTokensCache filePath (hash, dataArray, resultId)
                            evictIfNeeded semanticTokensCache
                            Some { data = Array.toList dataArray; resultId = Some resultId }

                let visitor =
                    { new IGameVisitor<_> with 
                        member this.Visit game = semanticTokensFunction game 
                    }
                return
                    gameDispatcher.Dispatch visitor
                    |> Option.flatten
            }
            |> catchError None

        member this.SemanticTokensFullDelta(p: SemanticTokensDeltaParams) =
            async {
                let semanticTokensFullDeltaFunction (game: IGame<_>) =
                    let filePath = p.textDocument.uri.LocalPath
                    let fileText = docs.GetText(FileInfo(filePath)) |> Option.defaultValue ""
                    let hash = contentHash fileText
                    match semanticTokensCache.TryGetValue(filePath) with
                    | true, (cachedHash, cachedData, cachedResultId) when cachedHash = hash ->
                        if p.previousResultId = cachedResultId then
                            Choice2Of2 { resultId = cachedResultId; edits = [] }
                        else
                            Choice1Of2 { data = Array.toList cachedData; resultId = Some cachedResultId }
                    | true, (_, oldDataArray, oldResultId) ->
                        let newDataArray = computeTokensForFile game filePath fileText
                        if newDataArray.Length = 0 then
                            Choice1Of2 { data = []; resultId = None }
                        else
                            let newResultId = Guid.NewGuid().ToString()
                            cachePut semanticTokensCache filePath (hash, newDataArray, newResultId)
                            evictIfNeeded semanticTokensCache
                            if p.previousResultId = oldResultId then
                                let edit = computeDelta oldDataArray newDataArray
                                Choice2Of2 { resultId = newResultId; edits = [ edit ] }
                            else
                                Choice1Of2 { data = Array.toList newDataArray; resultId = Some newResultId }
                    | _ ->
                        let newDataArray = computeTokensForFile game filePath fileText
                        if newDataArray.Length = 0 then
                            Choice1Of2 { data = []; resultId = None }
                        else
                            let newResultId = Guid.NewGuid().ToString()
                            cachePut semanticTokensCache filePath (hash, newDataArray, newResultId)
                            evictIfNeeded semanticTokensCache
                            Choice1Of2 { data = Array.toList newDataArray; resultId = Some newResultId }
                let visitor =
                    { new IGameVisitor<_> with
                        member this.Visit game = semanticTokensFullDeltaFunction game }
                return
                    gameDispatcher.Dispatch visitor
                    |> Option.map (fun c -> Some c)
                    |> Option.defaultValue None
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

        // P0 Fix: was TODO() return empty results / no-op instead of crashing
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
                        let locationToJson (r: CWTools.Utilities.Position.range) =
                            let lspRange = convRangeToLSPRange r
                            JsonValue.Record
                                [| "uri", JsonValue.String(Uri(r.FileName).ToString())
                                   "range",
                                   JsonValue.Record
                                       [| "start", codeLensPositionJson lspRange.start.line lspRange.start.character
                                          "end", codeLensPositionJson lspRange.``end``.line lspRange.``end``.character |] |]

                        match p with
                        | { command = "cwtools.findTypeReferences"
                            arguments = typeNameArg :: idArg :: _ } ->
                            let typeName = typeNameArg.AsString().Split('.').[0]
                            let id = idArg.AsString()
                            let cacheKey = typeReferenceResultCacheKey typeName id

                            let refs =
                                match typeReferenceResultCache.TryGetValue(cacheKey) with
                                | true, cached -> cached
                                | false, _ ->
                                    let result =
                                        match game.TypeReferenceIndex() |> Map.tryFind (typeName, id) with
                                        | Some refs when not refs.IsEmpty -> refs
                                        | _ -> game.FindAllRefsByType typeName id

                                    typeReferenceResultCache.[cacheKey] <- result
                                    result

                            refs
                            |> List.map locationToJson
                            |> Array.ofList
                            |> JsonValue.Array
                            |> Some
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
                            let configs = getConfigFiles cachePath useManualRules manualRulesFolder bundledRulesPath
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

                            filteredFiles
                            |> List.map (fun f -> pretriggerForFile client game docs f)
                            |> Async.Sequential
                            |> Async.Ignore
                            |> Async.RunSynchronously
                            None
                        | { command = "pretriggerThisFile"
                            arguments = x :: _ } ->
                            let filename = x.AsString()
                            pretriggerForFile client game docs filename
                            |> Async.RunSynchronously
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
                        // - AI-specific structured query commands -

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
                                            |> List.skip 1
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


                        | { command = "cwtools.ai.getCompletionContext"
                            arguments = uriArg :: lineArg :: colArg :: _ } ->
                            let filePath =
                                let raw = uriArg.AsString()
                                getPathFromDoc (Uri(raw))
                            let line = lineArg.AsInteger()
                            let col = colArg.AsInteger()
                            let position = PosHelper.fromZ line col
                            let fileContent =
                                match docs.GetText(FileInfo(filePath)) with
                                | Some t -> t
                                | None -> try File.ReadAllText filePath with _ -> ""
                            let lines = fileContent.Replace("\r\n", "\n").Split('\n')
                            let lineText =
                                if line >= 0 && line < lines.Length then lines.[line] else ""
                            let boundedColumn = Math.Max(0, Math.Min(col, lineText.Length))
                            let linePrefix = lineText.Substring(0, boundedColumn)
                            let tokenPrefix =
                                let m = System.Text.RegularExpressions.Regex.Match(linePrefix, @"[A-Za-z0-9_.:-]+$")
                                if m.Success then m.Value else ""
                            let fieldName =
                                let eqIndex = linePrefix.LastIndexOf("=")
                                if eqIndex >= 0 then
                                    let beforeEquals = linePrefix.Substring(0, eqIndex)
                                    let m = System.Text.RegularExpressions.Regex.Match(beforeEquals, @"([A-Za-z0-9_.:-]+)\s*$")
                                    if m.Success then m.Groups.[1].Value else ""
                                else ""
                            let isValueParameter = linePrefix.Contains("value:")
                            let expectedValueType =
                                if isValueParameter then "parameter_value"
                                elif not (String.IsNullOrWhiteSpace fieldName) then "field_value"
                                else "unknown"
                            let scopeJson =
                                match gameObj with
                                | Some g ->
                                    match g.ScopesAtPos position filePath fileContent with
                                    | Some scopes ->
                                        let thisScopeStr =
                                            scopes.Scopes |> List.tryHead |> Option.map string |> Option.defaultValue "unknown"
                                        let prevChain =
                                            scopes.Scopes
                                            |> List.skip 1
                                            |> List.map string
                                            |> Array.ofList
                                        let fromChain =
                                            scopes.From |> List.map string |> Array.ofList
                                        JsonValue.Record
                                            [| "thisScope", JsonValue.String thisScopeStr
                                               "root", JsonValue.String (scopes.Root.ToString())
                                               "currentScope", JsonValue.String thisScopeStr
                                               "prevChain", JsonValue.Array(prevChain |> Array.map JsonValue.String)
                                               "fromChain", JsonValue.Array(fromChain |> Array.map JsonValue.String) |]
                                    | None -> JsonValue.Null
                                | None -> JsonValue.Null
                            Some(
                                JsonValue.Record
                                    [| "ok", JsonValue.Boolean true
                                       "file", JsonValue.String (filePath.Replace('\\', '/'))
                                       "line", JsonValue.Number(decimal line)
                                       "column", JsonValue.Number(decimal col)
                                       "currentVersion", JsonValue.Number(decimal (docs.GetVersionByPath(filePath) |> Option.defaultValue -1))
                                       "linePrefix", JsonValue.String linePrefix
                                       "tokenPrefix", JsonValue.String tokenPrefix
                                       "fieldName", JsonValue.String fieldName
                                       "isValueParameter", JsonValue.Boolean isValueParameter
                                       "expectedValueType", JsonValue.String expectedValueType
                                       "scope", scopeJson
                                       "source", JsonValue.String "cwtools.ai.getCompletionContext" |])



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
                                        // Single filter pass reuse for both count and truncated result
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


                        // - cwtools.ai.queryDefinition -
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
                                    match
                                        g.GoToType position filePath fileContent
                                        |> preferCodeDefinitionOverLocalisation
                                            gameDispatcher
                                            g
                                            filePath
                                            fileContent
                                            line
                                            col
                                    with
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

                        // - cwtools.ai.queryDefinitionByName -
                        // Find where a named symbol (scripted_trigger, scripted_effect, event, type)
                        // is defined, by searching AllEntities for a top-level key that matches.
                        // Much more practical than position-based GoToType for AI use.
                        //
                        // Optimization: Phase 1 uses g.Types() an already-indexed Map<typeName, TypeDefInfo[]>
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
                                        |> Option.orElse (
                                            let visitor = 
                                                { new IGameVisitor<_> with 
                                                    member this.Visit game = tryFindInGame game 
                                                }
                                            gameDispatcher.Dispatch visitor |> Option.flatten
                                        )
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

                        // - cwtools.ai.queryScriptedEffects -
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

                        // - cwtools.ai.queryScriptedTriggers -
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

                        // - cwtools.ai.queryEnums -
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

                        // - cwtools.ai.queryStaticModifiers -
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

                        // - cwtools.ai.queryVariables -
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

                        // - cwtools.ai.getEntityInfo -
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

                        // - cwtools.ai.getDiagnosticsFresh -
                        // Immediately return the diagnostic freshness status of a file (without blocking)
                        | { command = cmd
                            arguments = uriArg :: _ } when
                                cmd = "cwtools.ai.getDiagnosticsFresh"
                                || cmd = "cwtools.ai.waitDiagnosticsFresh" ->
                            let filePath =
                                let raw = uriArg.AsString()
                                getPathFromDoc (Uri(raw))
                            let result =
                                match fileDiagnosticStates.TryGetValue(filePath) with
                                | true, state ->
                                    let currentVersion = docs.GetVersionByPath(filePath)
                                    let freshnessStr =
                                        match state.freshness with
                                        | Fresh -> "fresh" | Pending -> "pending" | Stale -> "stale"
                                    let diagnosticsJson =
                                        state.diagnostics
                                        |> List.map (fun d ->
                                            let codeText = d.code |> Option.defaultValue ""
                                            let dataJson =
                                                d.data
                                                |> Option.defaultWith (fun () -> diagnosticData codeText d.message)
                                            let dataString field fallback =
                                                match dataJson.TryGetProperty(field) with
                                                | Some(JsonValue.String value) -> value
                                                | _ -> fallback
                                            let optionalDataString field =
                                                match dataJson.TryGetProperty(field) with
                                                | Some(JsonValue.String value) when not (String.IsNullOrWhiteSpace value) ->
                                                    Some(field, JsonValue.String value)
                                                | _ -> None
                                            let optionalFields =
                                                [ "expectedType"
                                                  "actualType"
                                                  "scope"
                                                  "symbol" ]
                                                |> List.choose optionalDataString
                                            JsonValue.Record
                                                ([ "code", JsonValue.String codeText
                                                   "message", JsonValue.String d.message
                                                   "severity", JsonValue.String (match d.severity with Some DiagnosticSeverity.Error -> "error" | Some DiagnosticSeverity.Warning -> "warning" | Some DiagnosticSeverity.Information -> "info" | Some DiagnosticSeverity.Hint -> "hint" | _ -> "info")
                                                   "category", JsonValue.String (dataString "category" "unknown")
                                                   "repairHint", JsonValue.String (dataString "repairHint" "")
                                                   "confidence", JsonValue.String (dataString "confidence" "low")
                                                   "metadataSource", JsonValue.String (dataString "metadataSource" "message_heuristic")
                                                   "data", dataJson
                                                   "line", JsonValue.Number(decimal d.range.start.line)
                                                   "column", JsonValue.Number(decimal d.range.start.character) ]
                                                 @ optionalFields
                                                 |> List.toArray))
                                        |> Array.ofList
                                    JsonValue.Record
                                        [| "ok",                 JsonValue.Boolean true
                                           "file",              JsonValue.String (filePath.Replace('\\', '/'))
                                           "epoch",             JsonValue.Number(decimal state.epoch)
                                           "version",           JsonValue.Number(decimal (state.version |> Option.defaultValue -1))
                                           "currentVersion",    JsonValue.Number(decimal (currentVersion |> Option.defaultValue -1))
                                           "validatedVersion",  JsonValue.Number(decimal (state.validatedVersion |> Option.defaultValue -1))
                                           "updatedAtUnixMs",   JsonValue.Number(decimal state.updatedAtUnixMs)
                                           "freshness",         JsonValue.String freshnessStr
                                           "pendingGlobalKinds",JsonValue.Array(state.pendingGlobalKinds |> List.map JsonValue.String |> Array.ofList)
                                           "diagnostics",       JsonValue.Array diagnosticsJson
                                           "errorCount",        JsonValue.Number(decimal state.errorCount)
                                           "warningCount",      JsonValue.Number(decimal state.warningCount) |]
                                | false, _ ->
                                    JsonValue.Record
                                        [| "ok",        JsonValue.Boolean true
                                           "file",      JsonValue.String (filePath.Replace('\\', '/'))
                                           "freshness", JsonValue.String "stale"
                                           "epoch",     JsonValue.Number 0m
                                           "currentVersion", JsonValue.Number(decimal (docs.GetVersionByPath(filePath) |> Option.defaultValue -1))
                                           "validatedVersion", JsonValue.Number -1m
                                           "errorCount",JsonValue.Number 0m
                                           "warningCount", JsonValue.Number 0m |]
                            Some result

                        // waitDiagnosticsFresh is kept as a non-blocking compatibility alias.
                        // Actual waiting stays client-side to avoid holding an LSP read lock.

                        // - cwtools.ai.getValidationStatus -
                        // Return global verification status summary: current epoch, number of pending files, total number of files
                        | { command = "cwtools.ai.getValidationStatus" } ->
                            let currentEpoch = diagnosticEpoch.Value
                            let totalFiles = fileDiagnosticStates.Count
                            let pendingFiles =
                                fileDiagnosticStates.Values
                                |> Seq.filter (fun s -> s.freshness <> Fresh)
                                |> Seq.length
                            let allPendingKinds =
                                fileDiagnosticStates.Values
                                |> Seq.collect (fun s -> s.pendingGlobalKinds)
                                |> Seq.distinct
                                |> Seq.toArray
                            let freshness =
                                if pendingFiles = 0 then "fresh"
                                elif pendingFiles < totalFiles then "pending"
                                else "stale"
                            let runtime = validationRuntimeSnapshot ()
                            let result =
                                JsonValue.Record
                                    [| "ok",                 JsonValue.Boolean true
                                       "epoch",             JsonValue.Number(decimal currentEpoch)
                                       "freshness",         JsonValue.String freshness
                                       "totalFiles",        JsonValue.Number(decimal totalFiles)
                                       "pendingFiles",      JsonValue.Number(decimal pendingFiles)
                                       "pendingGlobalKinds",JsonValue.Array(allPendingKinds |> Array.map JsonValue.String)
                                       "inProgress",        JsonValue.Boolean runtime.inProgress
                                       "inProgressFile",    JsonValue.String runtime.inProgressFile
                                       "queueDepth",        JsonValue.Number(decimal runtime.queueDepth)
                                       "debounceQueueDepth",JsonValue.Number(decimal runtime.debounceQueueDepth)
                                       "needsTypeRefresh",  JsonValue.Boolean needsTypeRefresh
                                       "delayedLocalisationUpdate", JsonValue.Boolean delayedLocUpdate
                                       "refreshSkipCount",  JsonValue.Number(decimal refreshSkipCount)
                                       "nextAnalyzeDelayMs",JsonValue.Number(decimal (int delayTime.TotalMilliseconds))
                                       "lastTypeRefreshRequestedAtUnixMs", JsonValue.Number(decimal (dateTimeToUnixMs lastTypeRefreshRequestAt))
                                       "lastTypeRefreshCompletedAtUnixMs", JsonValue.Number(decimal (dateTimeToUnixMs lastTypeRefreshCompletedAt))
                                       "lastGlobalRefreshAtUnixMs", JsonValue.Number(decimal (dateTimeToUnixMs lastGlobalRefreshAt))
                                       "openDocuments",     JsonValue.Number(decimal (docs.OpenFiles() |> List.length))
                                       "refreshDomains",    refreshDomainSnapshotJson ()
                                       "runtime",           getRuntimeSnapshotJson ()
                                       "loading",           getLoadingSnapshotJson ()
                                       "completion",        getCompletionSnapshotJson ()
                                       "diagnosticSummary", getDiagnosticSummaryJson ()
                                       "memory",            getMemorySnapshotJson ()
                                       "caches",            getCacheSnapshotJson () |]
                            Some result

                        // - cwtools.ai.parseFragment -
                        // Fragment parsing: accepts code fragment text and returns syntax error (does not write to file)
                        | { command = "cwtools.ai.parseFragment"
                            arguments = codeArg :: _ } ->
                            let code = codeArg.AsString()
                            let virtualPath = "fragment://virtual.txt"

                            // 1. Try CKParser parsing
                            let parsed = CKParser.parseString code virtualPath
                            let parserErrors =
                                match parsed with
                                | Success _ -> []
                                | Failure(msg, p, _) ->
                                    [ {| line = int p.Position.Line
                                         col = int p.Position.Column
                                         message = msg |} ]

                            // 2. Bracket scanning
                            let braceIssues = scanBraceIssues code virtualPath
                            let braceErrors =
                                braceIssues
                                |> List.map (fun (_, _, _, msg, rng, _, _) ->
                                    {| line = int rng.StartLine
                                       col = int rng.StartColumn
                                       message = msg |})
                            let recoveryIssues = scanRecoveryIssues code virtualPath
                            let recoveryErrors =
                                recoveryIssues
                                |> List.map (fun (code, _, _, msg, rng, _, _) ->
                                    {| line = int rng.StartLine
                                       col = int rng.StartColumn
                                       message = sprintf "%s: %s" code msg |})

                            let allErrors = parserErrors @ braceErrors @ recoveryErrors
                            let fragments = splitTopLevelFragments code
                            let result =
                                JsonValue.Record
                                    [| "ok",       JsonValue.Boolean true
                                       "valid",    JsonValue.Boolean (allErrors.IsEmpty)
                                       "fragments", JsonValue.Number(decimal fragments.Length)
                                       "errors",   JsonValue.Array(
                                                        allErrors
                                                        |> List.map (fun e ->
                                                            JsonValue.Record
                                                                [| "line",    JsonValue.Number(decimal e.line)
                                                                   "col",     JsonValue.Number(decimal e.col)
                                                                   "message", JsonValue.String e.message |])
                                                        |> Array.ofList) |]
                            Some result

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
