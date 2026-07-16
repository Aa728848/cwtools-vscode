namespace Main.Lang

open LSP
open LSP.Types
open System
open System.Runtime.InteropServices
open CWTools.Utilities.Position
open CWTools.Games
open System.IO
open CWTools.Localisation

module LanguageServerFeatures =

    type IGameVisitor<'R> =
        abstract Visit<'T when 'T :> ComputedData> : IGame<'T> -> 'R

    type IGameDispatcher =
        abstract Dispatch<'R> : IGameVisitor<'R> -> 'R option

    /// Precompiled regular expressions to avoid recompiling every time you hover
    let private scriptedVarPattern =
        System.Text.RegularExpressions.Regex(
            @"^\s*(@[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n\r#]+)",
            System.Text.RegularExpressions.RegexOptions.Multiline ||| System.Text.RegularExpressions.RegexOptions.Compiled)

    let private paramPattern =
        System.Text.RegularExpressions.Regex(
            @"\$([A-Za-z_][A-Za-z0-9_]*)\$",
            System.Text.RegularExpressions.RegexOptions.Compiled)

    
    let convRangeToLSPRange (range: range) =
        { start =
            { line = max 0 (int range.StartLine - 1)
              character = (int range.StartColumn) }
          ``end`` =
            { line = max 0 (int range.EndLine - 1)
              character = (int range.EndColumn) } }

    /// Windows URI path correction tool function (eliminate duplicate code)
    let getPathFromDoc (doc: Uri) =
        let p = doc.LocalPath
        if RuntimeInformation.IsOSPlatform(OSPlatform.Windows) && p.Length > 0 && p.[0] = '/' then
            p.Substring(1)
        else p

    let filePathToUri (path: string) =
        let filePrefix = if path.StartsWith('/') then "file://" else "file:///"
        Uri(filePrefix + path.Replace('\\', '/'))

    let lochoverFromInfo (localisation: (string * Entry) list) (infoOption: SymbolInformation option) (word: string) =
        let locToText (loc: SymbolLocalisationInfo) =
            let locdesc =
                localisation
                |> List.tryPick (fun (k, v) -> if k = loc.value then Some v.desc else None)
                |> Option.defaultValue ""

            "|" + loc.key.Trim('\"') + "|" + locdesc.Trim('\"') + "|"

        match infoOption with
        | Some info ->
            match info.localisation with
            | [] ->
                localisation
                |> List.tryPick (fun (k, v) -> if k = word then Some v.desc else None)
            | [ h ] ->
                localisation
                |> List.tryPick (fun (k, v) -> if k = h.value then Some v.desc else None)
            | h :: t ->
                let head = locToText h
                let tail = t |> List.map locToText
                Some((head :: "|:---|:---|" :: tail) |> (fun s -> String.Join("\n", s)))
        | None ->
            localisation
            |> List.tryPick (fun (k, v) -> if k = word then Some v.desc else None)

    let docstringFromInfo (uiText: string -> string -> string) (infoOption: SymbolInformation option) =
        match infoOption with
        | Some info ->
            let ruleDesc = info.ruleDescription

            let scopes =
                match info.ruleRequiredScopes with
                | [] -> None
                | _ -> Some(uiText "Supports scopes: " "支持的作用域：" + String.Join(", ", info.ruleRequiredScopes))

            Some(String.Join("\n***\n", [| ruleDesc; scopes |] |> Array.choose id))
        | None -> None


    let hoverDocument
        (gameDispatcher: IGameDispatcher)
        (docs: DocumentStore)
        (doc: Uri)
        (pos: Position)
        (locMap: (string * Entry) list)
        (uiText: string -> string -> string)
        =
        async {
            let unescapedWord = docs.GetTextAtPosition(doc, pos)
            let position = Main.PosHelper.fromZ pos.line pos.character
            let path = getPathFromDoc doc

            let hoverFunction (game: IGame<_>) =
                // Optimization: only obtain the file text once, all subsequent operations share the same reference
                let fileContent = docs.GetText(FileInfo(doc.LocalPath)) |> Option.defaultValue ""

                let symbolInfo = game.InfoAtPos position path fileContent
                let scopeContext = game.ScopesAtPos position path fileContent

                let allEffects = game.ScriptedEffects() @ game.ScriptedTriggers()

                let hovered =
                    allEffects |> List.tryFind (fun e -> e.Name.GetString() = unescapedWord)

                // Use module-level precompiled regular expressions to extract variables
                let extractVarsFromFile (content: string) =
                    [ for m in scriptedVarPattern.Matches(content) ->
                        let name = m.Groups.[1].Value.Trim()
                        let value = m.Groups.[2].Value.Trim()
                        name, value ]

                let scriptedVariableInfo =
                    if unescapedWord.StartsWith("@[") then
                        None
                    else
                        let globalVars = game.ScriptedVariables()
                        let localVars = extractVarsFromFile fileContent
                        let allVars = localVars @ globalVars

                        let varName =
                            if unescapedWord.StartsWith('@') then unescapedWord
                            else "@" + unescapedWord
                        allVars
                        |> List.tryFind (fun (name, _) ->
                            let cleanName = name.TrimStart('@')
                            let cleanWord = unescapedWord.TrimStart('@')
                            name = unescapedWord || name = varName ||
                            cleanName = cleanWord ||
                            cleanName.Equals(cleanWord, StringComparison.OrdinalIgnoreCase))

                let variableHover =
                    scriptedVariableInfo
                    |> Option.map (fun (name, value) ->
                        let displayName = if name.StartsWith('@') then name else "@" + name
                        let params_found = paramPattern.Matches(value)
                        let definedParameters = [ for m in params_found -> m.Groups.[1].Value ] |> List.distinct
                        if definedParameters.Length > 0 then
                            let paramsStr = definedParameters |> List.map (fun p -> sprintf "`$%s$`" p) |> String.concat ", "
                            sprintf "`%s` = `%s`\n\n%s: %s" displayName value (uiText "Parameters" "参数") paramsStr
                        else
                            sprintf "`%s` = `%s`" displayName value)

                let lochover =
                    lochoverFromInfo locMap symbolInfo unescapedWord

                let nonEmptyString text =
                    if String.IsNullOrWhiteSpace text then None else Some text

                let overrideModeHover =
                    game.OverrideModeAtPath path
                    |> Option.bind (fun priority ->
                        let strategy = priority.strategy.Trim()
                        if strategy = "" then
                            None
                        else
                            Some(
                                sprintf
                                    "**%s**: `%s`\n\n%s: `%s`"
                                    (uiText "Path override mode" "路径覆盖模式")
                                    strategy
                                    (uiText "Matched path" "匹配路径")
                                    priority.path))

                let scopesExtra =
                    match scopeContext with
                    | None -> ""
                    | Some scopes ->
                        let header = sprintf "| %s | %s |\n| ----- | -----|\n" (uiText "Context" "上下文") (uiText "Scope" "作用域")
                        let root = $"| ROOT | %s{scopes.Root.ToString()} |\n"

                        let prevs =
                            scopes.Scopes
                            |> List.mapi (fun i s ->
                                "| "
                                + (if i = 0 then "THIS" else (String.replicate i "PREV"))
                                + " | "
                                + s.ToString()
                                + " |\n")
                            |> String.concat ""

                        let froms =
                            scopes.From
                            |> List.mapi (fun i s ->
                                "| "
                                + (String.replicate (i + 1) "FROM")
                                + " | "
                                + s.ToString()
                                + " |\n")
                            |> String.concat ""

                        header + root + prevs + froms

                let carrierHostHover =
                    if not (unescapedWord.Equals("carrier_event", StringComparison.OrdinalIgnoreCase)) then
                        None
                    else
                        match scopeContext, game with
                        | Some scopes, (:? IScopeInferenceProvider as provider) ->
                            provider.ScopeInferenceAtPos position path fileContent scopes
                            |> Option.filter (fun inference -> inference.kind = "carrier_host")
                            |> Option.map (fun inference ->
                                let candidates =
                                    inference.candidates
                                    |> List.distinct
                                    |> List.map (sprintf "`%s`")
                                    |> String.concat " / "

                                let resolvedScope = inference.resolvedScope

                                match inference.certainty.ToLowerInvariant() with
                                | "exact" ->
                                    sprintf
                                        "**%s**: `%s` — %s"
                                        (uiText "Carrier host" "载体宿主")
                                        resolvedScope
                                        (uiText "exact" "已确定")
                                | "union" ->
                                    sprintf
                                        "**%s**: `%s` (%s) — %s"
                                        (uiText "Carrier host" "载体宿主")
                                        resolvedScope
                                        candidates
                                        (uiText "union" "尚未唯一确定")
                                | _ ->
                                    sprintf
                                        "**%s**: `%s` (%s) — %s"
                                        (uiText "Carrier host" "载体宿主")
                                        (uiText "unknown" "未知")
                                        candidates
                                        (uiText "unresolved" "未解析"))
                        | _ -> None

                let eventTargetHover =
                    if unescapedWord.StartsWith("event_target:", StringComparison.OrdinalIgnoreCase) then
                        let rawName = unescapedWord.Substring("event_target:".Length).TrimEnd('?')
                        let dotIndex = rawName.IndexOf('.')
                        let name = if dotIndex >= 0 then rawName.Substring(0, dotIndex) else rawName

                        let saved =
                            game.References().SavedScopes
                            |> Seq.filter (fun (savedName, _, _) ->
                                String.Equals(savedName, name, StringComparison.OrdinalIgnoreCase))
                            |> Seq.toArray

                        let alternatives =
                            saved
                            |> Array.map (fun (_, _, scope) -> scope.ToString())
                            |> Array.distinct
                            |> Array.sort

                        let scopeText =
                            match alternatives with
                            | [||] -> sprintf "`%s` — %s" (uiText "unknown" "未知") (uiText "unresolved" "未解析")
                            | [| exact |] -> sprintf "`%s` — %s" exact (uiText "project-unique" "项目内唯一")
                            | many ->
                                many
                                |> Array.map (sprintf "`%s`")
                                |> String.concat ", "
                                |> fun scopes -> sprintf "%s — %s" scopes (uiText "ambiguous" "存在歧义")

                        let definitions =
                            saved
                            |> Array.truncate 5
                            |> Array.map (fun (_, targetRange, scope) ->
                                sprintf
                                    "- `%s` — `%s:%d:%d`"
                                    (scope.ToString())
                                    (targetRange.FileName.Replace('\\', '/'))
                                    (targetRange.StartLine + 1)
                                    (int targetRange.StartColumn + 1))
                            |> String.concat "\n"

                        Some(
                            sprintf
                                "**%s**: `%s`\n\n**%s**: %s%s"
                                (uiText "Event target" "事件目标")
                                name
                                (uiText "Scope" "作用域")
                                scopeText
                                (if definitions = "" then "" else "\n\n**" + uiText "Saved at" "保存于" + "**\n" + definitions)
                        )
                    else
                        None

                let effect =
                    hovered
                    |> Option.map (fun e ->
                        match e with
                        | :? CWTools.Common.DocEffect as de ->
                            let scopes =
                                de.Scopes
                                |> List.map (fun scope -> scope.ToString())
                                |> String.concat ", "

                            let desc =
                                de.Desc.Replace("_", "\\_").Trim()
                                |> (fun s -> if s = "" then "" else "_" + s + "_")

                            String.Join("\n***\n", [ desc; uiText "Supports scopes: " "支持的作用域：" + scopes ])
                        | e ->
                            let scopes =
                                e.Scopes
                                |> List.map (fun scope -> scope.ToString())
                                |> String.concat ", "
                            let name = e.Name.GetString().Replace("_", "\\_").Trim()
                            String.Join("\n***\n", [ "_" + name + "_"; uiText "Supports scopes: " "支持的作用域：" + scopes ]))

                let docStringOrEffect = Option.orElse (docstringFromInfo uiText symbolInfo) effect

                let inlineScriptPreview =
                    symbolInfo
                    |> Option.bind (fun info ->
                        if info.typename = "inline_script_file" && info.name <> "" then
                            let pathInfo =
                                info.localisation
                                |> List.tryFind (fun l -> l.key = "path")
                                |> Option.map (fun l -> l.value)
                                |> Option.defaultValue info.name
                            let preview =
                                info.localisation
                                |> List.tryFind (fun l -> l.key = "preview" && l.value <> "")
                                |> Option.map (fun l -> sprintf "```\n%s\n```" l.value)
                                |> Option.defaultValue ""
                            let header = sprintf "**%s**: `%s`" (uiText "Inline Script" "内联脚本") pathInfo
                            Some (if preview <> "" then header + "\n\n" + preview else header)
                        else None)

                let text =
                    [| overrideModeHover
                       (inlineScriptPreview |> Option.orElse docStringOrEffect)
                       lochover
                       nonEmptyString scopesExtra
                       carrierHostHover
                       eventTargetHover
                       variableHover |]
                    |> Array.choose id
                    |> (fun a -> String.Join("\n\n***\n\n", a))

                match text with
                | "" ->
                    { contents = MarkupContent("markdown", "")
                      range = None }
                | text ->
                    { contents = MarkupContent("markdown", text)
                      range = None }

            let visitor = 
                { new IGameVisitor<_> with 
                    member this.Visit game = hoverFunction game 
                }
            return
                gameDispatcher.Dispatch visitor
                |> Option.defaultValue { contents = MarkupContent("markdown", ""); range = None }

        }

    let pretriggerForFile (client: ILanguageClient) (game: IGame) (docs: DocumentStore) filename =
        async {
            let getEventChanges (deletes, insertPos, insertText) =
                let removes =
                    deletes
                    |> Seq.map (fun delRange ->
                        { range = convRangeToLSPRange delRange
                          newText = "" })
                    |> List.ofSeq

                let add =
                    { range = convRangeToLSPRange (mkRange filename insertPos insertPos)
                      newText = insertText }

                add :: removes

            let getFileText filename = File.ReadAllText filename

            let edits =
                game.GetCodeEdits filename (docs.GetText(FileInfo(filename)) |> Option.defaultValue (getFileText filename))

            let combined = edits |> Option.defaultValue [] |> List.collect getEventChanges

            match combined with
            | [] -> ()
            | textedits ->
                let fileInfo = FileInfo(filename)
                let version = docs.GetVersion(fileInfo) |> Option.defaultValue 0

                let docIdentifier =
                    { uri = filePathToUri filename
                      version = version }

                let changes =
                    { textDocument = docIdentifier
                      edits = textedits }

                let docChanges = { documentChanges = Some [ changes ]; changes = Map.empty }

                do!
                    client.ApplyWorkspaceEdit
                        { label = Some $"Pretriggers %s{fileInfo.Name}"
                          edit = docChanges }
                    |> Async.Ignore
        }

