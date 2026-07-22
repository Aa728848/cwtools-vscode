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
open Main.CompletionText

// Precompile regular expressions (avoid recompiling every time completion/resolve)
let private varExtractPattern =
    System.Text.RegularExpressions.Regex(
        @"^\s*(@[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n\r#]+)",
        System.Text.RegularExpressions.RegexOptions.Multiline ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private paramExtractPattern =
    System.Text.RegularExpressions.Regex(
        @"\$([A-Za-z_][A-Za-z0-9_]*)(?:\|([^$]*))?\$",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private numericCompletionLiteralPattern =
    System.Text.RegularExpressions.Regex(
        @"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private isNumericCompletionLiteral (label: string) =
    numericCompletionLiteralPattern.IsMatch(label.Trim())

let private userParamPattern =
    System.Text.RegularExpressions.Regex(
        @"\|([A-Za-z_][A-Za-z0-9_]*)[:=]([^\|]+)",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private macroParamPattern =
    System.Text.RegularExpressions.Regex(
        @"\$([A-Za-z_][A-Za-z0-9_]*)(?:\|([^$]*))?\$",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private macroBracketParamPattern =
    System.Text.RegularExpressions.Regex(
        @"\[\[\s*!?\s*([A-Za-z0-9_]+)(?=\]|\s)",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private valueCallTokenBoundaries = [|' '; '\t'; '='; '<'; '>'; '{'; '}'; ','; '"'; '\''; '\n'; '\r'|]

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

let private tryGetValueArgContext (textBeforeCursor: string) =
    try
        let lastPipeIdx = textBeforeCursor.LastIndexOf('|')
        if lastPipeIdx <= 0 then None
        else
            let afterPipe = textBeforeCursor.Substring(lastPipeIdx + 1)
            if afterPipe |> Seq.exists Char.IsWhiteSpace then None
            else
                let tokenStart = textBeforeCursor.LastIndexOfAny(valueCallTokenBoundaries)
                let potentialToken =
                    if tokenStart < textBeforeCursor.Length - 1 then
                        textBeforeCursor.Substring(tokenStart + 1)
                    else ""

                let cleanToken = potentialToken.TrimStart('"', '\'')
                if not (cleanToken.StartsWith("value:", StringComparison.OrdinalIgnoreCase)) then
                    None
                else
                    let cleanToken = cleanToken.Substring(6)
                    let parts = cleanToken.Split('|')
                    let entityName = if parts.Length > 0 then parts.[0] else ""
                    if entityName = "" then None
                    else
                        let firstPipeIdx = cleanToken.IndexOf('|')
                        if firstPipeIdx < 0 then None
                        else
                            let afterFirstPipe = cleanToken.Substring(firstPipeIdx + 1)
                            let pipeCount = afterFirstPipe |> Seq.filter ((=) '|') |> Seq.length
                            Some(entityName, pipeCount % 2 = 0)
    with _ -> None

let private tryFindScriptValueLikeType (game: IGame) (entityName: string) =
    game.Types()
    |> Map.toSeq
    |> Seq.sortBy fst
    |> Seq.tryPick (fun (_, definitions) ->
        definitions |> Array.tryFind (fun definition -> definition.id = entityName))

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

    tryGetValueArgContext textBeforeCursor
    |> Option.bind (fun (entityName, isParamPosition) ->
        if not isParamPosition then None
        else
            tryFindScriptValueLikeType game entityName
            |> Option.bind (fun t ->
                tryReadTypeFileText docs t.range.FileName
                |> Option.bind (fun sourceText ->
                    let values =
                        [ for m in macroParamPattern.Matches(sourceText) -> m.Groups.[1].Value
                          for m in macroBracketParamPattern.Matches(sourceText) -> m.Groups.[1].Value ]
                        |> List.distinct
                        |> List.filter (fun x -> x <> "")

                    if values.IsEmpty then None else Some values)))

// ─── Parameter value completion ──────────────────────────────────────────────
// When the cursor sits at `PARAM = <cursor>` inside a call to a scripted
// effect/trigger/value or inline_script, proxy the completion request to the
// `field = $PARAM$` usage site inside the definition. The rules engine then
// supplies exactly the values valid for that slot, including scope handling.

let private paramValueContextPattern =
    System.Text.RegularExpressions.Regex(
        @"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(""?)?([^\s""={}]*)$",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private inlineScriptPathPattern =
    System.Text.RegularExpressions.Regex(
        @"\bscript\s*=\s*""?([\w\./\-]+)",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private absoluteOffsetOf (text: string) (position: pos) =
    let mutable idx = 0
    let mutable currentLine = 0
    while currentLine < position.Line - 1 && idx < text.Length do
        if text.[idx] = '\n' then currentLine <- currentLine + 1
        idx <- idx + 1
    Math.Min(idx + Math.Max(0, position.Column), text.Length)

let private lineColOfOffset (text: string) (offset: int) =
    let mutable line = 0
    let mutable lineStart = 0
    for i in 0 .. offset - 1 do
        if text.[i] = '\n' then
            line <- line + 1
            lineStart <- i + 1
    struct (line, offset - lineStart)

/// Best-effort backwards scan to the innermost unmatched '{'; returns the clause key
/// before it and the brace offset. Strings/comments are not tracked, which is
/// acceptable for PDX script where braces inside strings are rare.
let private tryFindEnclosingCall (text: string) (fromOffset: int) =
    let mutable depth = 0
    let mutable i = fromOffset - 1
    let mutable braceIdx = -1
    while braceIdx < 0 && i >= 0 do
        (match text.[i] with
         | '}' -> depth <- depth + 1
         | '{' -> if depth = 0 then braceIdx <- i else depth <- depth - 1
         | _ -> ())
        i <- i - 1
    if braceIdx < 0 then None
    else
        let mutable j = braceIdx - 1
        while j >= 0 && Char.IsWhiteSpace text.[j] do j <- j - 1
        if j < 0 || text.[j] <> '=' then None
        else
            j <- j - 1
            while j >= 0 && Char.IsWhiteSpace text.[j] do j <- j - 1
            let keyEnd = j
            let isKeyChar c =
                Char.IsLetterOrDigit c || c = '_' || c = '.' || c = ':' || c = '@' || c = '-'
            while j >= 0 && isKeyChar text.[j] do j <- j - 1
            if keyEnd > j then Some(text.Substring(j + 1, keyEnd - j), braceIdx) else None

let private tryFindParamDefinitionFile (game: IGame) (callKey: string) (text: string) (braceOffset: int) =
    if callKey.Equals("inline_script", StringComparison.OrdinalIgnoreCase) then
        // Resolve the inline script's definition file from its `script = <path>` field.
        let blockEnd =
            let mutable depth = 0
            let mutable i = braceOffset
            let mutable e = -1
            while e < 0 && i < text.Length do
                (match text.[i] with
                 | '{' -> depth <- depth + 1
                 | '}' ->
                     depth <- depth - 1
                     if depth = 0 then e <- i
                 | _ -> ())
                i <- i + 1
            if e < 0 then text.Length else e

        let blockText = text.Substring(braceOffset, blockEnd - braceOffset)
        let m = inlineScriptPathPattern.Match(blockText)
        if not m.Success then None
        else
            let rel = "common/inline_scripts/" + m.Groups.[1].Value.Replace('\\', '/') + ".txt"
            game.AllFiles()
            |> List.tryPick (fun r ->
                match r with
                | EntityResource(f, e) when
                    e.logicalpath.Replace('\\', '/').EndsWith(rel, StringComparison.OrdinalIgnoreCase)
                    ->
                    Some f
                | _ -> None)
    else
        let types = game.Types()

        types
        |> Map.toSeq
        |> Seq.sortBy fst
        |> Seq.tryPick (fun (_, definitions) ->
            definitions
            |> Array.tryFind (fun definition -> String.Equals(definition.id, callKey, StringComparison.OrdinalIgnoreCase))
            |> Option.map (fun definition -> definition.range.FileName))

let private trySliceNamedDefinitionBlock (text: string) (callKey: string) =
    let pattern =
        @"(?m)^\s*" + System.Text.RegularExpressions.Regex.Escape(callKey) + @"\s*="

    let m =
        System.Text.RegularExpressions.Regex.Match(
            text,
            pattern,
            System.Text.RegularExpressions.RegexOptions.None)

    if not m.Success then None
    else
        let braceIdx = text.IndexOf('{', m.Index)
        if braceIdx < 0 then None
        else
            let mutable depth = 0
            let mutable i = braceIdx
            let mutable blockEnd = -1

            while blockEnd < 0 && i < text.Length do
                match text.[i] with
                | '{' -> depth <- depth + 1
                | '}' ->
                    depth <- depth - 1
                    if depth = 0 then blockEnd <- i
                | _ -> ()

                i <- i + 1

            let endExclusive = if blockEnd >= 0 then blockEnd + 1 else text.Length
            Some(text.Substring(m.Index, endExclusive - m.Index))

type private ParamValueUsage =
    { positions: pos list
      defaultValue: string option
      startOffset: int
      endOffset: int
      isKeyUsage: bool }

let private isWholeParamBoundary c =
    Char.IsWhiteSpace c
    || c = '='
    || c = '<'
    || c = '>'
    || c = '{'
    || c = '}'
    || c = ','
    || c = '('
    || c = ')'
    || c = '['
    || c = ']'
    || c = '"'
    || c = '\''
    || c = '\n'
    || c = '\r'

let private isWholeParamToken (text: string) (startIdx: int) (endIdxExclusive: int) =
    let leftOk =
        startIdx <= 0 || isWholeParamBoundary text.[startIdx - 1]

    let rightOk =
        endIdxExclusive >= text.Length || isWholeParamBoundary text.[endIdxExclusive]

    leftOk && rightOk

let private tryNextNonWhitespace (text: string) (startIdx: int) =
    let mutable i = startIdx
    while i < text.Length && Char.IsWhiteSpace text.[i] do
        i <- i + 1

    if i < text.Length then Some text.[i] else None

/// Find complete `$PARAM$` (or `$PARAM|default$`) uses that occupy a whole
/// PDX token. Embedded fragments such as `foo_$PARAM$_bar` cannot be safely
/// projected to a concrete rule slot, so they are ignored.
let private findParamValueUsages (defText: string) (paramKey: string) =
    [ for m in paramExtractPattern.Matches(defText) do
          if
              m.Success
              && String.Equals(m.Groups.[1].Value, paramKey, StringComparison.OrdinalIgnoreCase)
              && isWholeParamToken defText m.Index (m.Index + m.Length)
          then
              let struct (line0, col0) = lineColOfOffset defText m.Index

              let defaultValue =
                  if m.Groups.[2].Success then
                      let value = m.Groups.[2].Value
                      if value = "" then None else Some value
                  else
                      None

              { positions = [ PosHelper.fromZ line0 (col0 + 1); PosHelper.fromZ line0 col0 ]
                defaultValue = defaultValue
                startOffset = m.Index
                endOffset = m.Index + m.Length
                isKeyUsage = tryNextNonWhitespace defText (m.Index + m.Length) = Some '=' } ]

let private paramValueMaxItems = 5000

let private tryGetParameterValueCompletion
    (game: IGame)
    (docs: DocumentStore)
    (currentFilePath: string)
    (filetext: string)
    (position: pos)
    (supportsInsertReplaceEdit: bool)
    =
    try
        let textBeforeCursor = getTextBeforeCursor filetext position
        let contextMatch = paramValueContextPattern.Match(textBeforeCursor)

        if not contextMatch.Success then None
        else
            let paramKey = contextMatch.Groups.[1].Value
            let hasOpeningQuote = contextMatch.Groups.[2].Success && contextMatch.Groups.[2].Value = "\""
            let typedPrefix =
                if contextMatch.Groups.[3].Success then contextMatch.Groups.[3].Value else ""

            let wantsVariableValue = typedPrefix.StartsWith("@", StringComparison.Ordinal)

            let createInsertText (label: string) =
                if hasOpeningQuote then label
                elif label.Contains ' ' then $"\"{label}\""
                else label

            let valueTextEdit (newText: string) =
                if supportsInsertReplaceEdit then
                    let targetLine = getLineAt filetext (position.Line - 1)
                    let replaceStart = Math.Max(0, position.Column - typedPrefix.Length)
                    let isValueChar c =
                        not (
                            Char.IsWhiteSpace c
                            || c = '"'
                            || c = '='
                            || c = '{'
                            || c = '}'
                        )

                    let mutable replaceEnd = Math.Min(position.Column, targetLine.Length)
                    while replaceEnd < targetLine.Length && isValueChar targetLine.[replaceEnd] do
                        replaceEnd <- replaceEnd + 1

                    let range =
                        { start = { line = position.Line - 1; character = replaceStart }
                          ``end`` = { line = position.Line - 1; character = replaceEnd } }

                    Some { newText = newText; insert = range; replace = range }
                else
                    None

            let filterTextFor forceTypedPrefix (label: string) =
                if forceTypedPrefix && typedPrefix <> "" then Some typedPrefix else Some label

            let cursorOff = absoluteOffsetOf filetext position

            match tryFindEnclosingCall filetext cursorOff with
            | None -> None
            | Some(callKey, braceOffset) ->
                match tryFindParamDefinitionFile game callKey filetext braceOffset with
                | None -> None
                | Some defFile ->
                    tryReadTypeFileText docs defFile
                    |> Option.bind (fun defText ->
                        let defText =
                            if callKey.Equals("inline_script", StringComparison.OrdinalIgnoreCase) then
                                defText
                            else
                                trySliceNamedDefinitionBlock defText callKey
                                |> Option.defaultValue defText

                        let usages = findParamValueUsages defText paramKey

                        if usages.IsEmpty then
                            None
                        else

                            let toKind (c: CompletionCategory) =
                                match c with
                                | CompletionCategory.Link -> CompletionItemKind.Method
                                | CompletionCategory.Value -> CompletionItemKind.Value
                                | CompletionCategory.Global -> CompletionItemKind.Constant
                                | CompletionCategory.Variable -> CompletionItemKind.Variable
                                | _ -> CompletionItemKind.Value

                            let buildItems responses =
                                let seen = HashSet<string>(StringComparer.OrdinalIgnoreCase)
                                let items = ResizeArray<CompletionItem>()
                                let mutable responseAdded = false

                                let rawDefaultValues =
                                    usages
                                    |> List.choose _.defaultValue
                                    |> List.filter (fun dv -> dv <> "")

                                let defaultValues =
                                    rawDefaultValues
                                    |> List.filter (fun dv ->
                                        not (isNumericCompletionLiteral dv)
                                        && (not wantsVariableValue
                                            || dv.StartsWith("@", StringComparison.Ordinal)))

                                let rawResponseValues =
                                    responses
                                    |> Seq.choose (fun resp ->
                                        let label, desc, kind =
                                            match resp with
                                            | CompletionResponse.Simple(l, _, k) -> l, None, k
                                            | CompletionResponse.Detailed(l, d, _, k) -> l, d, k
                                            | CompletionResponse.Snippet(l, _, d, _, k) -> l, d, k

                                        if label <> "" && not (label.StartsWith("$", StringComparison.Ordinal)) then
                                            Some(label, desc, kind)
                                        else
                                            None)
                                    |> Seq.toList

                                let responseValues =
                                    rawResponseValues
                                    |> List.filter (fun (label, _, _) -> not (isNumericCompletionLiteral label))

                                let forceTypedPrefix =
                                    typedPrefix <> ""
                                    && not (
                                        (defaultValues
                                         |> List.exists (fun label ->
                                             label.StartsWith(typedPrefix, StringComparison.OrdinalIgnoreCase)))
                                        || (responseValues
                                            |> List.exists (fun (label, _, _) ->
                                                label.StartsWith(typedPrefix, StringComparison.OrdinalIgnoreCase)))
                                    )

                                for dv in defaultValues do
                                    if seen.Add dv then
                                        let insertText = createInsertText dv
                                        items.Add
                                            { defaultCompletionItem with
                                                label = dv
                                                kind = Some CompletionItemKind.Value
                                                insertText =
                                                    if supportsInsertReplaceEdit || insertText = dv then None else Some insertText
                                                filterText = filterTextFor forceTypedPrefix dv
                                                textEdit = valueTextEdit insertText
                                                sortText = Some "0000000"
                                                documentation =
                                                    Some
                                                        { kind = MarkupKind.Markdown
                                                          value = $"Default value of `${paramKey}$`" } }

                                for label, desc, kind in responseValues do
                                    if items.Count < paramValueMaxItems then
                                        if seen.Add label then
                                            let insertText = createInsertText label
                                            responseAdded <- true
                                            items.Add
                                                { defaultCompletionItem with
                                                    label = label
                                                    kind = Some(toKind kind)
                                                    insertText =
                                                        if supportsInsertReplaceEdit || insertText = label then None else Some insertText
                                                    filterText = filterTextFor forceTypedPrefix label
                                                    textEdit = valueTextEdit insertText
                                                    documentation =
                                                        desc
                                                        |> Option.map (fun d ->
                                                            { kind = MarkupKind.Markdown; value = d }) }

                                if items.Count = 0 then
                                    if rawDefaultValues.Length > 0 || rawResponseValues.Length > 0 then
                                        Some([], true)
                                    else
                                        None
                                else
                                    Some(List.ofSeq items, responseAdded)

                            let definitionAttempts =
                                usages
                                |> List.collect (fun usage ->
                                    let direct =
                                        usage.positions
                                        |> List.map (fun p -> struct (defFile, defText, p))

                                    let syntheticText =
                                        defText
                                            .Remove(usage.startOffset, usage.endOffset - usage.startOffset)
                                            .Insert(usage.startOffset, typedPrefix)

                                    let struct (line0, col0) =
                                        lineColOfOffset syntheticText (usage.startOffset + typedPrefix.Length)

                                    let synthetic =
                                        struct (defFile, syntheticText, PosHelper.fromZ line0 col0)

                                    if wantsVariableValue then [ synthetic ] else direct @ [ synthetic ])

                            let callSiteAttempts =
                                if usages |> List.exists (fun u -> u.isKeyUsage) then
                                    [ struct (currentFilePath, filetext, position) ]
                                else
                                    []

                            let completionAttempts = definitionAttempts @ callSiteAttempts

                            let mutable defaultOnlyItems = None
                            let mutable filteredOnlyItems = None

                            completionAttempts
                            |> List.tryPick (fun struct (completionFile, completionText, completionPos) ->
                                let responses = game.Complete completionPos completionFile completionText
                                match buildItems responses with
                                | Some([], true) ->
                                    if filteredOnlyItems.IsNone then
                                        filteredOnlyItems <- Some []
                                    None
                                | Some(items, true) -> Some items
                                | Some(items, false) ->
                                    if defaultOnlyItems.IsNone then
                                        defaultOnlyItems <- Some items
                                    None
                                | None -> None)
                            |> Option.orElseWith (fun () -> defaultOnlyItems)
                            |> Option.orElseWith (fun () -> filteredOnlyItems))
    with _ ->
        None

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

        let wordStart, cursor, wordEnd = tokenRangeInLine targetLine character

        // Return the ranges as a tuple to avoid anonymous record issues
        let insertRange =
            { start =
                { line = line - 1
                  character = wordStart }
              ``end`` =
                { line = line - 1
                  character = cursor } }

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
        // Incomplete-list retries fire while the user extends the same token, so the raw
        // candidate set for the slot is unchanged — match on (uri, line) only and let the
        // caller re-filter by the longer prefix instead of recomputing the candidates.
        match lock completionPartialCacheLock (fun () -> completionPartialCache) with
        | Some(cachedKey, cachedItems) when cachedKey.uri = key.uri && cachedKey.line = key.line ->
            // Cached items carry textEdit ranges anchored at the original request's cursor;
            // re-anchor them to the current cursor or VS Code rejects the items and closes
            // the completion list after a couple of keystrokes.
            let insertRange, replaceRange =
                computeCompletionRanges filetext (p.position.line + 1) p.position.character

            cachedItems
            |> List.map (fun item ->
                match item.textEdit with
                | Some te ->
                    { item with
                        textEdit =
                            Some
                                { te with
                                    insert = insertRange
                                    replace = replaceRange } }
                | None -> item)
            :> seq<_>
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
                    let valueIdx = textBefore.LastIndexOf("value:", StringComparison.OrdinalIgnoreCase)
                    if valueIdx <> -1 && not (textBefore.Substring(valueIdx + 6) |> Seq.exists Char.IsWhiteSpace) then
                        let afterValue = textBefore.Substring(valueIdx + 6)
                        let pipeIdx = afterValue.LastIndexOf('|')
                        let insertStartCol =
                            if pipeIdx <> -1 then valueIdx + 6 + pipeIdx + 1 else valueIdx
                        let insertRange = { start = { line = line - 1; character = insertStartCol }
                                            ``end`` = { line = line - 1; character = col } }
                        Some (insertRange, insertRange)
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
        let currentFilePath =
            let u = p.textDocument.uri

            if
                RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                && u.LocalPath.StartsWith "/"
            then
                u.LocalPath.Substring(1)
            else
                u.LocalPath

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
                        let replaceStart =
                            let pipeIdx = textBeforeCursor.LastIndexOf('|')
                            if pipeIdx >= 0 then pipeIdx + 1 else position.Column
                        let insertRange = { start = { line = lspLine; character = replaceStart }
                                            ``end`` = { line = lspLine; character = position.Column } }
                        Some { newText = text; insert = insertRange; replace = insertRange }
                    else None

                let paramItems = 
                    macroParams 
                    |> List.map (fun p -> 
                        let insertText = $"{p}|"
                        { defaultCompletionItem with 
                            label = p
                            kind = Some CompletionItemKind.Variable
                            insertText = if supportsInsertReplaceEdit then None else Some insertText
                            filterText = Some p
                            sortText = Some "0000000"
                            textEdit = paramTextEdit insertText
                        })

                logInfo $"completion script-value params time %i{stopwatch.ElapsedMilliseconds}ms"
                Some { isIncomplete = false; items = paramItems }
            | None ->
                // Parameter / inline_script value completion: when the cursor is at
                // `PARAM = <cursor>` inside a call, proxy to the definition's `$PARAM$` slot.
                let paramValueItems =
                    tryGetParameterValueCompletion game docs currentFilePath filetext position supportsInsertReplaceEdit

                if paramValueItems.IsSome then
                    logInfo $"completion param-value time %i{stopwatch.ElapsedMilliseconds}ms"

                    Some
                        { isIncomplete = false
                          items = paramValueItems.Value }
                else

                // Normal (non-script_value) completion path
                let items = getRawItems () |> Seq.toArray
                logInfo $"completion items time %i{stopwatch.ElapsedMilliseconds}ms"

                let prefixSoFar = prefixFromTextBeforeCursor textBeforeCursor

                // '@' scripted-variable tokens: always narrow server-side and mark the list
                // incomplete so each keystroke re-requests. VS Code's client-side fuzzy filter
                // matches scattered characters inside long variable names, so large @-variable
                // sets never visibly narrow without server-side prefix filtering.
                let atVariableToken =
                    match prefixSoFar with
                    | Some p -> p.StartsWith("@", StringComparison.Ordinal)
                    | None -> false

                // Single-pass: materialize once, then dedup + filter + count in one pass
                let itemCount = items.Length
                let partialReturn = itemCount > 2000 || atVariableToken

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

                // '@' token with no prefix match (typo): keep the widget alive by returning
                // the full variable list with filterText pinned to the typed token, so VS Code
                // does not dismiss the list — backspacing then resumes narrowing normally.
                if atVariableToken && dedupedItems.Count = 0 then
                    let typedToken = prefixSoFar |> Option.defaultValue "@"

                    for i in 0 .. items.Length - 1 do
                        let item = items.[i]

                        if item.label.StartsWith("@", StringComparison.Ordinal) then
                            let key = struct (item.label, item.documentation)

                            if seen.Add(key) then
                                dedupedItems.Add { item with filterText = Some typedToken }

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
