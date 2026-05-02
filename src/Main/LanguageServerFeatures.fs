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

    /// 预编译的正则表达式，避免每次 hover 时重新编译
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

    /// Windows URI 路径修正工具函数（消除重复代码）
    let getPathFromDoc (doc: Uri) =
        let p = doc.LocalPath
        if RuntimeInformation.IsOSPlatform(OSPlatform.Windows) && p.Length > 0 && p.[0] = '/' then
            p.Substring(1)
        else p

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

    let docstringFromInfo (infoOption: SymbolInformation option) =
        match infoOption with
        | Some info ->
            let ruleDesc = info.ruleDescription

            let scopes =
                match info.ruleRequiredScopes with
                | [] -> None
                | _ -> Some("Supports scopes: " + String.Join(", ", info.ruleRequiredScopes))

            Some(String.Join("\n***\n", [| ruleDesc; scopes |] |> Array.choose id))
        | None -> None


    let hoverDocument
        (gameDispatcher: IGameDispatcher)
        (docs: DocumentStore)
        (doc: Uri)
        (pos: Position)
        =
        async {
            let unescapedWord = docs.GetTextAtPosition(doc, pos)
            let position = Main.PosHelper.fromZ pos.line pos.character
            let path = getPathFromDoc doc

            let hoverFunction (game: IGame<_>) =
                // 优化：只获取一次文件文本，所有后续操作共享同一引用
                let fileContent = docs.GetText(FileInfo(doc.LocalPath)) |> Option.defaultValue ""

                let symbolInfo = game.InfoAtPos position path fileContent
                let scopeContext = game.ScopesAtPos position path fileContent

                let allEffects = game.ScriptedEffects() @ game.ScriptedTriggers()

                let hovered =
                    allEffects |> List.tryFind (fun e -> e.Name.GetString() = unescapedWord)

                // 使用模块级预编译正则提取变量
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
                            sprintf "`%s` = `%s`\n\nParameters: %s" displayName value paramsStr
                        else
                            sprintf "`%s` = `%s`" displayName value)

                let lochover =
                    lochoverFromInfo (game.References().Localisation) symbolInfo unescapedWord

                let scopesExtra =
                    match scopeContext with
                    | None -> ""
                    | Some scopes ->
                        let header = "| Context | Scope |\n| ----- | -----|\n"
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
                                "| " + (String.replicate (i + 1) "FROM") + " | " + s.ToString() + " |\n")
                            |> String.concat ""

                        header + root + prevs + froms

                let effect =
                    hovered
                    |> Option.map (fun e ->
                        match e with
                        | :? CWTools.Common.DocEffect as de ->
                            let scopes = String.Join(", ", de.Scopes |> List.map (fun f -> f.ToString()))

                            let desc =
                                de.Desc.Replace("_", "\\_").Trim()
                                |> (fun s -> if s = "" then "" else "_" + s + "_")

                            String.Join("\n***\n", [ desc; "Supports scopes: " + scopes ])
                        | e ->
                            let scopes = String.Join(", ", e.Scopes |> List.map (fun f -> f.ToString()))
                            let name = e.Name.GetString().Replace("_", "\\_").Trim()
                            String.Join("\n***\n", [ "_" + name + "_"; "Supports scopes: " + scopes ]))

                let docStringOrEffect = Option.orElse (docstringFromInfo symbolInfo) effect

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
                            let header = sprintf "**Inline Script**: `%s`" pathInfo
                            Some (if preview <> "" then header + "\n\n" + preview else header)
                        else None)

                let text =
                    [| inlineScriptPreview |> Option.orElse docStringOrEffect; lochover; Some scopesExtra; variableHover |]
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
                    { uri = Uri(filename)
                      version = version }

                let changes =
                    { textDocument = docIdentifier
                      edits = textedits }

                let docChanges = { documentChanges = [ changes ]; changes = Map.empty }

                do!
                    client.ApplyWorkspaceEdit
                        { label = Some $"Pretriggers %s{fileInfo.Name}"
                          edit = docChanges }
        }

