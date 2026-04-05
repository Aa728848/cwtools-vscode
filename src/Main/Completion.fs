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


let completionCache = Dictionary<int, CompletionItem>()
let mutable private rangeCache: (string * int * int * Range * Range) option = None

let mutable private completionCacheKey = 0

let addToCache completionItem =
    let key = completionCacheKey
    completionCacheKey <- completionCacheKey + 1
    completionCache.Add(key, completionItem)
    key

let mutable completionCacheCount = 0

let mutable private completionPartialCache: (CompletionParams * CompletionItem seq) option =
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
                        let pattern = System.Text.RegularExpressions.Regex(@"^\s*(@[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n\r#]+)", System.Text.RegularExpressions.RegexOptions.Multiline)
                        [ for m in pattern.Matches(content) ->
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
                        let paramPattern = System.Text.RegularExpressions.Regex(@"\$([A-Za-z_][A-Za-z0-9_]*)(?:\|([^$]*))?\$")
                        let params_found = paramPattern.Matches(value)
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
                                let userParamPattern = System.Text.RegularExpressions.Regex(@"\|([A-Za-z_][A-Za-z0-9_]*)[:=]([^\|]+)")
                                [ for m in userParamPattern.Matches(text) -> m.Groups.[1].Value, m.Groups.[2].Value ]
                                |> List.distinctBy fst
                            | None ->
                                let userParamPattern = System.Text.RegularExpressions.Regex(@"\|([A-Za-z_][A-Za-z0-9_]*)[:=]([^\|]+)")
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
    match rangeCache with
    | Some(cachedText, cachedLine, cachedChar, cachedInsert, cachedReplace) when
        cachedText = filetext && cachedLine = line && cachedChar = character
        ->
        (cachedInsert, cachedReplace)
    | _ ->
        let lines = filetext.Split('\n')

        let targetLine =
            if line > 0 && line <= lines.Length then
                lines.[line - 1]
            else
                ""

        //TODO: This needs to handle localisation differently really
        let isWordChar c = not (Char.IsWhiteSpace(c) || c = '.')

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
        rangeCache <- Some(filetext, line, character, insertRange, replaceRange)

        (insertRange, replaceRange)

let optimiseCompletion (completionList: CompletionItem seq) =
    if completionCacheCount > 2 then
        completionCache.Clear()
        completionCacheCount <- 0
    else
        completionCacheCount <- completionCacheCount + 1

    let cachedCompletionList = Seq.cache completionList

    match cachedCompletionList |> Seq.length with
    | x when x > 1000 ->
        let sorted = cachedCompletionList |> Seq.sortBy (fun c -> c.sortText)

        let first = sorted |> Seq.take 1000

        let rest =
            sorted
            |> Seq.skip 1000
            |> Seq.take (min 1000 (x - 1000))
            |> Seq.map (fun item ->
                let key = addToCache item

                { item with
                    documentation = None
                    detail = None
                    data = JsonValue.Number(decimal key) })

        seq {
            yield! first
            yield! rest
        }
    | _ -> cachedCompletionList

let checkPartialCompletionCache (p: CompletionParams) genItems =
    match p.context, completionPartialCache, p.textDocument, p.position with
    | Some { triggerKind = CompletionTriggerKind.TriggerForIncompleteCompletions }, Some(c, res), td, pos when
        c.position.line = pos.line && c.textDocument.uri = td.uri
        ->
        res
    | _ ->
        let items = genItems ()
        completionPartialCache <- Some(p, items)
        items

let completionCallLSP (game: IGame) (p: CompletionParams) _ debugMode supportsInsertReplaceEdit filetext position =

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

    /// 计算智能补全范围
    /// 如果是 script_value 参数输入（value:xxx|yyy），范围应从 | 之后开始
    let computeSmartCompletionRanges (filetext: string) (line: int) (col: int) =
        try
            let lines = filetext.Split('\n')
            if line >= 0 && line < lines.Length then
                let currentLine = lines.[line]
                // 查找 "value:" 关键字
                // 我们需要找到光标左侧最近的 "value:" 和 "|"
                let textBefore = currentLine.Substring(0, min col currentLine.Length)
                let valueIdx = textBefore.LastIndexOf("value:")
                
                if valueIdx <> -1 then
                    // 在 value: 之后查找 |
                    let afterValue = textBefore.Substring(valueIdx + 6)
                    let pipeIdx = afterValue.IndexOf('|')
                    
                    if pipeIdx <> -1 then
                        // 找到了 value:...|...
                        // 插入起点应该是 | 之后的位置
                        let insertStartCol = valueIdx + 6 + pipeIdx + 1
                        let insertRange = { start = { line = line; character = insertStartCol }
                                            ``end`` = { line = line; character = col } }
                        // 替换范围通常与插入范围相同
                        insertRange, insertRange
                    else
                        // 没找到 |，使用默认范围
                        computeCompletionRanges filetext line col
                else
                    // 没找到 value:，使用默认范围
                    computeCompletionRanges filetext line col
            else
                computeCompletionRanges filetext line col
        with _ ->
            computeCompletionRanges filetext line col

    /// Create the appropriate textEdit based on client capabilities
    let createTextEdit text =
        if supportsInsertReplaceEdit then
            let (insertRange, replaceRange) =
                computeSmartCompletionRanges filetext position.Line position.Column

            Some(
                { newText = text
                  insert = insertRange
                  replace = replaceRange }
            )
        else
            // Fallback to regular TextEdit for older clients
            None // Let the client use insertText instead

    let items =
        comp
        |> Seq.map (function
            | CompletionResponse.Simple(e, Some score, kind) ->
                let insertText = createInsertText e

                // 如果是 ScriptValue 参数，添加 "|" 到 filterText 以帮助 VSCode 匹配
                // 这样如果 VSCode 认为 "|" 是单词一部分，也能匹配
                let finalFilterText =
                    if kind = CompletionCategory.Value && e <> "yes" && e <> "no" then
                        Some($"|{e}")
                    else
                        Some e

                { defaultCompletionItemKind (convertKind kind) with
                    label = e
                    filterText = finalFilterText
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

                let finalFilterText =
                    if kind = CompletionCategory.Value && e <> "yes" && e <> "no" then
                        Some($"|{e}")
                    else
                        Some e

                { defaultCompletionItemKind (convertKind kind) with
                    label = e
                    filterText = finalFilterText
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

        let items =
            checkPartialCompletionCache p (fun () ->
                completionCallLSP game p docs debugMode supportsInsertReplaceEdit filetext position)
            |> Seq.cache

        logInfo $"completion items time %i{stopwatch.ElapsedMilliseconds}ms"
        let split = filetext.Split('\n')
        let targetLine = split[position.Line - 1]
        let textBeforeCursor = targetLine.Remove(position.Column)
        logInfo $"{p} {position}"

        // 检测是否处于 script_value 参数输入环境：value:name|...
        // 如果是，我们只应该匹配最后一个 '|' 之后的文本，而不是整行
        let isInScriptValueArg = textBeforeCursor.Contains("value:") && textBeforeCursor.Contains("|")
        
        let prefixSoFar =
            if isInScriptValueArg then
                // 提取最后一个 '|' 之后的文本
                let lastPipeIdx = textBeforeCursor.LastIndexOf('|')
                let textAfterPipe = textBeforeCursor.Substring(lastPipeIdx + 1)
                // 获取正在输入的单词
                match textAfterPipe.Split([| ' '; '\t' |]) |> Array.tryLast with
                | Some word when not (String.IsNullOrWhiteSpace word) -> Some word
                | _ -> None
            else
                // 恢复原始逻辑：使用 Split([||]) 按单词边界分割
                match textBeforeCursor.Split([||]) |> Array.tryLast with
                | Some lastWord when not (String.IsNullOrWhiteSpace lastWord) -> lastWord.Split('.') |> Array.last |> Some
                | _ -> None

        logInfo $"prefixSoFar: %A{prefixSoFar} isScriptValue: {isInScriptValueArg}"

        let partialReturn = items |> Seq.length > 2000

        let filtered =
            match prefixSoFar, partialReturn with
            | None, _ -> items
            | _, false -> items
            | Some prefix, true ->
                items
                |> Seq.filter (fun i -> i.label.Contains(prefix, StringComparison.OrdinalIgnoreCase))

        let deduped =
            filtered
            |> Seq.distinctBy (fun i -> (i.label, i.documentation))
            |> Seq.filter (fun i -> not (i.label.StartsWith("$", StringComparison.OrdinalIgnoreCase)))

        let optimised = optimiseCompletion deduped
        let itemsList = optimised |> Seq.toList

        // 检测是否是我们的 script_value 补全（基于 sortText = 1000000）
        let isScriptValueLike =
            itemsList
            |> List.tryHead
            |> Option.bind (fun i -> i.sortText)
            |> (function | Some "1000000" -> true | _ -> false)

        // 如果是 script_value 补全，设置 isIncomplete = true 以强制 VSCode 显示所有项，绕过客户端过滤
        // 同时设置 filterText 为 label，确保匹配
        // 如果处于 script_value 参数输入环境，也强制设置 isIncomplete = true
        let finalItemsList =
            if isScriptValueLike || isInScriptValueArg then
                itemsList |> List.map (fun i ->
                    { i with filterText = Some i.label })
            else
                itemsList

        Some
            { isIncomplete = partialReturn || isScriptValueLike || isInScriptValueArg
              items = finalItemsList }
    // |false ->
    //     let extraKeywords = ["yes"; "no";]
    //     let eventIDs = game.References.EventIDs
    //     let names = eventIDs @ game.References.TriggerNames @ game.References.EffectNames @ game.References.ModifierNames @ game.References.ScopeNames @ extraKeywords
    //     let variables = game.References.ScriptVariableNames |> List.map (fun v -> {defaultCompletionItem with label = v; kind = Some CompletionItemKind.Variable })
    //     let items = names |> List.map (fun n -> {defaultCompletionItem with label = n})
    //     Some {isIncomplete = false; items = items @ variables}
    | None -> None
