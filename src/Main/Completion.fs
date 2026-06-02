module Main.Completion

open System
open System.Collections.Generic
open System.IO
open System.Runtime.InteropServices
open CWTools.Common
open CWTools.Games
open CWTools.Utilities.Position
open FSharp.Data
open LSP
open LSP.Types
open CWTools.Utilities.Utils

// Precompile regular expressions (avoid recompiling every time completion/resolve)
let private varExtractPattern =
    System.Text.RegularExpressions.Regex(
        @"^\s*(@[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n\r#]+)",
        System.Text.RegularExpressions.RegexOptions.Multiline ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private paramExtractPattern =
    System.Text.RegularExpressions.Regex(
        @"\$([A-Za-z_][A-Za-z0-9_]*)(?:\|([^$]*))?\$",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private userParamPattern =
    System.Text.RegularExpressions.Regex(
        @"\|([A-Za-z_][A-Za-z0-9_]*)[:=]([^\|]+)",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private macroParamPattern =
    System.Text.RegularExpressions.Regex(
        @"\$([A-Za-z_][A-Za-z0-9_]*)(?:\|([^$]*))?\$",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private valueArgTokenBoundaries = [|' '; '\t'; '='; '<'; '>'; '{'; '}'; ','; '\n'; '\r'|]
let private completionPrefixBoundaries = [|' '; '\t'; '='; '<'; '>'; '{'; '}'; ','; ':'; '|'; '('; ')'; '['; ']'; '"'; '\''; '\n'; '\r'|]

/// Extract a single line from text without allocating a full string[] via Split.
let private getLineAt (text: string) (lineIdx: int) =
    if lineIdx < 0 then ""
    else
        let mutable idx = 0
        let mutable currentLine = 0
        while currentLine < lineIdx && idx < text.Length do
            if text.[idx] = '\n' then currentLine <- currentLine + 1
            idx <- idx + 1
        if idx >= text.Length then ""
        else
            let lineEnd =
                let mutable e = idx
                while e < text.Length && text.[e] <> '\n' && text.[e] <> '\r' do e <- e + 1
                e
            text.Substring(idx, lineEnd - idx)

let private getTextBeforeCursor (filetext: string) (position: pos) =
    let targetLine = getLineAt filetext (position.Line - 1)
    let safeColumn = Math.Max(0, Math.Min(position.Column, targetLine.Length))
    targetLine.Substring(0, safeColumn)

let private tryGetValueArgEntity (textBeforeCursor: string) =
    try
        let lastPipeIdx = textBeforeCursor.LastIndexOf('|')
        if lastPipeIdx <= 0 then None
        else
            let afterPipe = textBeforeCursor.Substring(lastPipeIdx + 1)
            if afterPipe |> Seq.exists Char.IsWhiteSpace then None
            else
                let tokenStart = textBeforeCursor.LastIndexOfAny(valueArgTokenBoundaries)
                let potentialToken =
                    if tokenStart < lastPipeIdx then
                        textBeforeCursor.Substring(tokenStart + 1, lastPipeIdx - tokenStart - 1)
                    else ""

                if not (potentialToken.StartsWith("value:", StringComparison.OrdinalIgnoreCase)) then
                    None
                else
                    let cleanToken = potentialToken.Substring(6)
                    let parts = cleanToken.Split('|')
                    let entityName = if parts.Length > 0 then parts.[0] else ""
                    if entityName = "" then None else Some entityName
    with _ -> None

let private tryFindScriptValueLikeType (game: IGame) (entityName: string) =
    let types = game.Types()
    let tryFind typeName =
        types
        |> Map.tryFind typeName
        |> Option.bind (fun arr -> arr |> Array.tryFind (fun t -> t.id = entityName))

    tryFind "script_value"
    |> Option.orElseWith (fun () -> tryFind "scripted_effect")

let private tryReadTypeFileText (docs: DocumentStore) (filePath: string) =
    if String.IsNullOrEmpty(filePath) then None
    else
        try
            match docs.GetText(FileInfo(filePath)) with
            | Some text when text <> "" -> Some text
            | _ ->
                if File.Exists(filePath) then
                    let text = File.ReadAllText(filePath)
                    if text = "" then None else Some text
                else
                    None
        with _ -> None

let private tryGetScriptValueMacroParams (game: IGame) (docs: DocumentStore) (filetext: string) (position: pos) =
    let textBeforeCursor = getTextBeforeCursor filetext position

    tryGetValueArgEntity textBeforeCursor
    |> Option.bind (fun entityName ->
        tryFindScriptValueLikeType game entityName
        |> Option.bind (fun t ->
            tryReadTypeFileText docs t.range.FileName
            |> Option.bind (fun sourceText ->
                let values =
                    [ for m in macroParamPattern.Matches(sourceText) -> m.Groups.[1].Value ]
                    |> List.distinct
                    |> List.filter (fun x -> x <> "")

                if values.IsEmpty then None else Some values)))

let private completionPrefixFromTextBeforeCursor (textBeforeCursor: string) =
    let boundary = textBeforeCursor.LastIndexOfAny(completionPrefixBoundaries)
    let token =
        if boundary >= 0 then textBeforeCursor.Substring(boundary + 1)
        else textBeforeCursor
    let dotIdx = token.LastIndexOf('.')
    let prefix =
        if dotIdx >= 0 then token.Substring(dotIdx + 1)
        else token

    if String.IsNullOrWhiteSpace prefix then None else Some prefix

let completionCache = System.Collections.Concurrent.ConcurrentDictionary<int, CompletionItem>()
let private rangeCacheLock = obj()
let mutable private rangeCache: (string * int * int * Range * Range) option = None

let mutable private completionCacheKey = 0

let addToCache completionItem =
    let key = System.Threading.Interlocked.Increment(&completionCacheKey) - 1
    completionCache.[key] <- completionItem
    key

let private completionTextHash (text: string) =
    let mutable hash = 2166136261u
    for i in 0 .. text.Length - 1 do
        hash <- (hash ^^^ (uint32 text.[i])) * 16777619u
    int hash


type private CompletionPartialCacheKey =
    { uri: Uri
      line: int
      character: int
      textHash: int }

let private completionPartialCacheLock = obj()

let mutable private completionPartialCache: (CompletionPartialCacheKey * CompletionItem list) option =
    None

let completionResolveItem (gameObj: IGame option) (item: CompletionItem) =
    async {
        logInfo "Completion resolve"

        let item =
            match item.data with
            | JsonValue.Number key -> completionCache.GetValueOrDefault(key |> int, item)
            | _ -> item

        return
            match gameObj with
            | Some game ->
                // First check if it's a scripted effect or trigger
                let allEffects = game.ScriptedEffects() @ game.ScriptedTriggers()
                let hovered = allEffects |> List.tryFind (fun e -> e.Name.GetString() = item.label)

                match hovered with
                | Some effect ->
                    match effect with
                    | :? DocEffect as de ->
                        let desc = "_" + de.Desc.Replace("_", "\\_") + "_"

                        let scopes =
                            "Supports scopes: "
                            + String.Join(", ", de.Scopes |> List.map (fun f -> f.ToString()))

                        let usage = de.Usage

                        let content = String.Join("\n***\n", [ desc; scopes; usage ])

                        { item with
                            documentation =
                                Some(
                                    { kind = MarkupKind.Markdown
                                      value = content }
                                ) }
                    | :? ScriptedEffect as se ->
                        let desc = se.Name.GetString().Replace("_", "\\_")
                        let comments = se.Comments.Replace("_", "\\_")

                        let scopes =
                            "Supports scopes: "
                            + String.Join(", ", se.Scopes |> List.map (fun f -> f.ToString()))

                        let content = String.Join("\n***\n", [ desc; comments; scopes ])

                        { item with
                            documentation =
                                Some(
                                    { kind = MarkupKind.Markdown
                                      value = content }
                                ) }
                    | e ->
                        let desc = "_" + e.Name.GetString().Replace("_", "\\_") + "_"

                        let scopes =
                            "Supports scopes: "
                            + String.Join(", ", e.Scopes |> List.map (fun f -> f.ToString()))

                        let content = String.Join("\n***\n", [ desc; scopes ])

                        { item with
                            documentation =
                                Some(
                                    { kind = MarkupKind.Markdown
                                      value = content }
                                ) }
                | None ->
                    // Check if it's a scripted variable
                    let allVars = game.ScriptedVariables()
                    let varName =
                        if item.label.StartsWith('@') then item.label
                        else "@" + item.label

                    // Helper function to extract variable name-value pairs from file content
                    let extractVarsFromFile (content: string) =
                        [ for m in varExtractPattern.Matches(content) ->
                            let name = m.Groups.[1].Value.Trim()
                            let value = m.Groups.[2].Value.Trim()
                            name, value ]

                    // Combine global and local variables
                    let effectiveVars =
                        // Note: We don't have access to file content here, so we use global vars
                        // For local vars, they would need to be passed from the completion call
                        allVars

                    let varInfo =
                        effectiveVars
                        |> List.tryFind (fun (name, _) ->
                            let cleanName = name.TrimStart('@')
                            let cleanLabel = item.label.TrimStart('@')
                            name = varName || name = item.label ||
                            cleanName = cleanLabel ||
                            cleanName.Equals(cleanLabel, StringComparison.OrdinalIgnoreCase))

                    match varInfo with
                    | Some (name, value) ->
                        // Extract parameters from value (patterns like $PARAM$ or $PARAM|default$)
                        let params_found = paramExtractPattern.Matches(value)
                        let definedParameters =
                            [ for m in params_found ->
                                let paramName = m.Groups.[1].Value
                                let defaultVal = if m.Groups.Count > 2 && m.Groups.[2].Success then m.Groups.[2].Value else ""
                                paramName, defaultVal ]
                            |> List.distinctBy fst

                        // Try to extract user-provided parameters from the completion item's insertText or label
                        let userProvidedParams =
                            match item.insertText with
                            | Some text ->
                                [ for m in userParamPattern.Matches(text) -> m.Groups.[1].Value, m.Groups.[2].Value ]
                                |> List.distinctBy fst
                            | None ->
                                [ for m in userParamPattern.Matches(item.label) -> m.Groups.[1].Value, m.Groups.[2].Value ]
                                |> List.distinctBy fst

                        // Validate parameters: check if user-provided params match defined params
                        let invalidParams =
                            userProvidedParams
                            |> List.filter (fun (p, _) -> not (definedParameters |> List.exists (fun (dp, _) -> dp = p)))

                        let validationWarning =
                            if invalidParams.Length > 0 then
                                let invalidList = String.Join(", ", invalidParams |> List.map (fun (p, _) -> sprintf "`%s`" p))
                                sprintf "\n\n⚠️ **Parameter validation failed**: Parameters not declared in variable definition: %s" invalidList
                            elif userProvidedParams.Length > 0 && definedParameters.Length > 0 then
                                "\n\n✅ **Parameter validation passed**: All provided parameters are declared in the variable definition"
                            else
                                ""

                        let varDoc =
                            if definedParameters.Length > 0 then
                                let paramsStr =
                                    definedParameters
                                    |> List.map (fun (p, d) ->
                                        if d <> "" then
                                            sprintf "- `$%s$` - Parameter (default: `%s`)" p d
                                        else
                                            sprintf "- `$%s$` - Parameter" p)
                                    |> String.concat "\n"

                                let usageExample =
                                    if userProvidedParams.Length > 0 then
                                        sprintf "\n\n**Your usage**:\n%s" (
                                            userProvidedParams
                                            |> List.map (fun (p, v) -> sprintf "- `%s` = `%s`" p v)
                                            |> String.concat "\n")
                                    else
                                        ""

                                sprintf "**Scripted Variable**: `%s`\n\n**Value**: `%s`\n\n**Parameters**:\n%s%s%s"
                                    name value paramsStr usageExample validationWarning
                            else
                                sprintf "**Scripted Variable**: `%s`\n\n**Value**: `%s`%s" name value validationWarning

                        { item with
                            documentation =
                                Some(
                                    { kind = MarkupKind.Markdown
                                      value = varDoc }
                                ) }
                    | None -> item
            | None -> item
    }



/// Compute ranges for InsertReplaceEdit based on word boundaries using simple position data
let computeCompletionRanges (filetext: string) (line: int) (character: int) =
    // Check cache first - if same file content, line, and character, return cached result
    let cached = lock rangeCacheLock (fun () -> rangeCache)
    match cached with
    | Some(cachedText, cachedLine, cachedChar, cachedInsert, cachedReplace) when
        cachedText = filetext && cachedLine = line && cachedChar = character
        ->
        (cachedInsert, cachedReplace)
    | _ ->
        let targetLine = getLineAt filetext (line - 1)

        //TODO: This needs to handle localisation differently really
        let isWordChar c =
            not (
                Char.IsWhiteSpace(c)
                || c = '.'
                || c = '|'
                || c = '"'
                || c = '='
                || c = '{'
                || c = '}'
                || c = ','
                || c = ':'
            )

        // Walk backward to find start of word/identifier
        let mutable wordStart = character

        while wordStart > 0
              && wordStart <= targetLine.Length
              && isWordChar targetLine.[wordStart - 1] do
            wordStart <- wordStart - 1

        // Walk forward to find end of word/identifier
        let mutable wordEnd = character

        while wordEnd < targetLine.Length && isWordChar targetLine.[wordEnd] do
            wordEnd <- wordEnd + 1

        // Return the ranges as a tuple to avoid anonymous record issues
        let insertRange =
            { start =
                { line = line - 1
                  character = wordStart }
              ``end`` =
                { line = line - 1
                  character = character } }

        let replaceRange =
            { start =
                { line = line - 1
                  character = wordStart }
              ``end`` = { line = line - 1; character = wordEnd } }

        // Cache the result
        lock rangeCacheLock (fun () -> rangeCache <- Some(filetext, line, character, insertRange, replaceRange))

        (insertRange, replaceRange)

let clearRangeCache () =
    lock rangeCacheLock (fun () -> rangeCache <- None)

let private completionCacheMaxEntries = 2048

let optimiseCompletion (completionList: CompletionItem seq) =
    // Evict completionCache when it exceeds capacity
    if completionCache.Count > completionCacheMaxEntries then
        completionCache.Clear()
        completionCacheKey <- 0

    // Optimization: Use Array instead of Seq to avoid multiple traversals
    let arr = completionList |> Seq.toArray

    logDiag $"completion cache items={arr.Length} cacheEntries={completionCache.Count}"

    if arr.Length > 1000 then
        Array.sortInPlaceBy (fun (c: CompletionItem) -> c.sortText) arr

        let first = arr |> Array.take 1000
        let restLen = min 1000 (arr.Length - 1000)

        let rest =
            arr
            |> Array.skip 1000
            |> Array.take restLen
            |> Array.map (fun item ->
                let key = addToCache item

                { item with
                    documentation = None
                    detail = None
                    data = JsonValue.Number(decimal key) })

        seq {
            yield! first
            yield! rest
        }
    else arr :> seq<_>

let checkPartialCompletionCache (p: CompletionParams) (filetext: string) genItems =
    let key =
        { uri = p.textDocument.uri
          line = p.position.line
          character = p.position.character
          textHash = completionTextHash filetext }

    let isIncompleteRetry =
        match p.context with
        | Some { triggerKind = CompletionTriggerKind.TriggerForIncompleteCompletions } -> true
        | _ -> false

    if isIncompleteRetry then
        match lock completionPartialCacheLock (fun () -> completionPartialCache) with
        | Some(cachedKey, cachedItems) when cachedKey = key -> cachedItems :> seq<_>
        | _ ->
            let items = genItems () |> Seq.toList
            lock completionPartialCacheLock (fun () -> completionPartialCache <- Some(key, items))
            items :> seq<_>
    else
        let items = genItems () |> Seq.toList
        lock completionPartialCacheLock (fun () -> completionPartialCache <- Some(key, items))
        items :> seq<_>

let completionCallLSP (game: IGame) (p: CompletionParams) debugMode supportsInsertReplaceEdit (filetext: string) (position: pos) =

    let path =
        let u = p.textDocument.uri

        if
            RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            && u.LocalPath.StartsWith "/"
        then
            u.LocalPath.Substring(1)
        else
            u.LocalPath

    let comp = game.Complete position path filetext


    // logInfo $"completion {prefixSoFar}"
    // let extraKeywords = ["yes"; "no";]
    // let eventIDs = game.References.EventIDs
    // let names = eventIDs @ game.References.TriggerNames @ game.References.EffectNames @ game.References.ModifierNames @ game.References.ScopeNames @ extraKeywords
    let convertKind (x: CompletionCategory) =
        match x with
        | CompletionCategory.Link -> (true, CompletionItemKind.Method)
        | CompletionCategory.Value -> (false, CompletionItemKind.Value)
        | CompletionCategory.Global -> (false, CompletionItemKind.Constant)
        | CompletionCategory.Variable -> (false, CompletionItemKind.Variable)
        | _ -> (false, CompletionItemKind.Function)

    /// Wrap in quotes if it contains spaces
    let createInsertText (s: string) =
        if s.Contains " " && not (s.StartsWith("\"")) && not (s.EndsWith("\"")) then
            $"\"{s}\""
        else
            s

    // Precompute completion ranges ONCE (position and filetext are the same for all items).
    // Previously, computeSmartCompletionRanges called filetext.Split('\n') per item,
    // causing 8000+ splits of a 4000-line file on every completion request (= ~3 seconds).
    let precomputedRanges =
        if supportsInsertReplaceEdit then
            try
                let line = position.Line   // 1-based
                let col = position.Column  // 0-based
                let currentLine = getLineAt filetext (line - 1)
                if currentLine <> "" then
                    let textBefore = currentLine.Substring(0, min col currentLine.Length)
                    let valueIdx = textBefore.LastIndexOf("value:")
                    if valueIdx <> -1 then
                        let afterValue = textBefore.Substring(valueIdx + 6)
                        let pipeIdx = afterValue.LastIndexOf('|')
                        if pipeIdx <> -1 then
                            let insertStartCol = valueIdx + 6 + pipeIdx + 1
                            let insertRange = { start = { line = line - 1; character = insertStartCol }
                                                ``end`` = { line = line - 1; character = col } }
                            Some (insertRange, insertRange)
                        else
                            Some (computeCompletionRanges filetext line col)
                    else
                        Some (computeCompletionRanges filetext line col)
                else
                    Some (computeCompletionRanges filetext line col)
            with e ->
                logError $"computeCompletionRanges fallback: {e.Message}"
                Some (computeCompletionRanges filetext position.Line position.Column)
        else
            None

    /// Create the appropriate textEdit based on client capabilities
    let createTextEdit text =
        match precomputedRanges with
        | Some (insertRange, replaceRange) ->
            Some(
                { newText = text
                  insert = insertRange
                  replace = replaceRange }
            )
        | None ->
            None

    let items =
        comp
        |> Seq.map (function
            | CompletionResponse.Simple(e, Some score, kind) ->
                let insertText = createInsertText e

                { defaultCompletionItemKind (convertKind kind) with
                    label = e
                    labelDetails =
                        if debugMode then
                            Some
                                { detail = Some $"({score})"
                                  description = None }
                        else
                            None
                    insertText = if supportsInsertReplaceEdit then None else Some insertText
                    textEdit = createTextEdit insertText
                    sortText = Some((maxCompletionScore - score).ToString()) }
            | CompletionResponse.Simple(e, None, kind) ->
                let insertText = createInsertText e

                { defaultCompletionItemKind (convertKind kind) with
                    label = e
                    insertText = if supportsInsertReplaceEdit then None else Some insertText
                    textEdit = createTextEdit insertText
                    sortText = Some(maxCompletionScore.ToString()) }
            | CompletionResponse.Detailed(l, d, Some score, kind) ->
                let insertText = createInsertText l

                { defaultCompletionItemKind (convertKind kind) with
                    label = l
                    labelDetails =
                        if debugMode then
                            Some
                                { detail = Some $"({score})"
                                  description = None }
                        else
                            None
                    insertText = if supportsInsertReplaceEdit then None else Some insertText
                    textEdit = createTextEdit insertText
                    documentation =
                        d
                        |> Option.map (fun d ->
                            { kind = MarkupKind.Markdown
                              value = d })
                    sortText = Some((maxCompletionScore - score).ToString()) }
            | CompletionResponse.Detailed(l, d, None, kind) ->
                let insertText = createInsertText l

                { defaultCompletionItemKind (convertKind kind) with
                    label = l
                    insertText = if supportsInsertReplaceEdit then None else Some insertText
                    textEdit = createTextEdit insertText
                    documentation =
                        d
                        |> Option.map (fun d ->
                            { kind = MarkupKind.Markdown
                              value = d }) }
            | CompletionResponse.Snippet(l, e, d, Some score, kind) ->
                { defaultCompletionItemKind (convertKind kind) with
                    label = l
                    labelDetails =
                        if debugMode then
                            Some
                                { detail = Some $"({score})"
                                  description = None }
                        else
                            None
                    insertText = if supportsInsertReplaceEdit then None else Some e
                    insertTextFormat = Some InsertTextFormat.Snippet
                    textEdit = createTextEdit e
                    documentation =
                        d
                        |> Option.map (fun d ->
                            { kind = MarkupKind.Markdown
                              value = d })
                    sortText = Some((maxCompletionScore - score).ToString()) }
            | CompletionResponse.Snippet(l, e, d, None, kind) ->
                { defaultCompletionItemKind (convertKind kind) with
                    label = l
                    insertText = if supportsInsertReplaceEdit then None else Some e
                    insertTextFormat = Some InsertTextFormat.Snippet
                    textEdit = createTextEdit e
                    documentation =
                        d
                        |> Option.map (fun d ->
                            { kind = MarkupKind.Markdown
                              value = d }) })

    items

let completion
    (gameObj: IGame option)
    (p: CompletionParams)
    (docs: DocumentStore)
    (debugMode: bool)
    (supportsInsertReplaceEdit: bool)
    =
    match gameObj with
    | Some game ->
        // match experimental_completion with
        // |true ->

        // let variables = game.References.ScriptVariableNames |> List.map (fun v -> {defaultCompletionItem with label = v; kind = Some CompletionItemKind.Variable })
        // logInfo (sprintf "completion prefix %A %A" prefixSoFar (items |> List.map (fun x -> x.label)))

        let stopwatch = System.Diagnostics.Stopwatch.StartNew()
        let position = PosHelper.fromZ p.position.line p.position.character // |> (fun p -> Pos.fromZ)

        let filetext =
            (docs.GetText(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue "")

        logInfo $"{p} {position}"

        let textBeforeCursor = getTextBeforeCursor filetext position

        let getRawItems () =
            checkPartialCompletionCache p filetext (fun () ->
                completionCallLSP game p debugMode supportsInsertReplaceEdit filetext position)

        try
            match tryGetScriptValueMacroParams game docs filetext position with
            | Some macroParams ->
                // Compute textEdit range for parameter insertion (right after last |)
                let paramTextEdit (text: string) =
                    if supportsInsertReplaceEdit then
                        let lspLine = position.Line - 1
                        let insertRange = { start = { line = lspLine; character = position.Column }
                                            ``end`` = { line = lspLine; character = position.Column } }
                        Some { newText = text; insert = insertRange; replace = insertRange }
                    else None

                let paramItems = 
                    macroParams 
                    |> List.map (fun p -> 
                        { defaultCompletionItem with 
                            label = p
                            kind = Some CompletionItemKind.Variable
                            insertText = if supportsInsertReplaceEdit then None else Some p
                            filterText = Some p
                            sortText = Some "0000000"
                            textEdit = paramTextEdit p
                        })

                logInfo $"completion script-value params time %i{stopwatch.ElapsedMilliseconds}ms"
                Some { isIncomplete = false; items = paramItems }
            | None ->
                // Normal (non-script_value) completion path
                let items = getRawItems () |> Seq.toArray
                logInfo $"completion items time %i{stopwatch.ElapsedMilliseconds}ms"

                let prefixSoFar = completionPrefixFromTextBeforeCursor textBeforeCursor

                // Single-pass: materialize once, then dedup + filter + count in one pass
                let itemCount = items.Length
                let partialReturn = itemCount > 2000

                // Single-pass dedup + filter using HashSet
                let seen = HashSet<struct (string * MarkupContent option)>()
                let dedupedItems = ResizeArray<CompletionItem>(min itemCount 2048)
                for i in 0 .. items.Length - 1 do
                    let item = items.[i]
                    if not (item.label.StartsWith("$", StringComparison.OrdinalIgnoreCase)) then
                        let matchesPrefix =
                            match prefixSoFar, partialReturn with
                            | None, _ -> true
                            | _, false -> true
                            | Some prefix, true ->
                                let filterText = item.filterText |> Option.defaultValue item.label
                                item.label.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                                || filterText.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                                || item.label.Contains(prefix, StringComparison.OrdinalIgnoreCase)
                        if matchesPrefix then
                            let key = struct (item.label, item.documentation)
                            if seen.Add(key) then
                                dedupedItems.Add(item)

                let optimised = optimiseCompletion dedupedItems
                let itemsList = optimised |> Seq.toList

                let isScriptValueLike =
                    itemsList
                    |> List.tryHead
                    |> Option.bind (fun i -> i.sortText)
                    |> (function | Some "1000000" -> true | _ -> false)

                let finalItemsList =
                    if isScriptValueLike then
                        itemsList |> List.map (fun i -> { i with filterText = Some i.label })
                    else
                        itemsList

                Some
                    { isIncomplete = partialReturn || isScriptValueLike
                      items = finalItemsList }
        with e ->
            logError $"Completion fallback: {e.Message}"
            // Fallback: return raw items without any processing
            let fallbackItems =
                try getRawItems () |> Seq.toList
                with _ -> []
            Some { isIncomplete = false; items = fallbackItems }
    // |false ->
    //     let extraKeywords = ["yes"; "no";]
    //     let eventIDs = game.References.EventIDs
    //     let names = eventIDs @ game.References.TriggerNames @ game.References.EffectNames @ game.References.ModifierNames @ game.References.ScopeNames @ extraKeywords
    //     let variables = game.References.ScriptVariableNames |> List.map (fun v -> {defaultCompletionItem with label = v; kind = Some CompletionItemKind.Variable })
    //     let items = names |> List.map (fun n -> {defaultCompletionItem with label = n})
    //     Some {isIncomplete = false; items = items @ variables}
    | None -> None
