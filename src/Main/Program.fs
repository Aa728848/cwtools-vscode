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
open Main.SemanticGraph
open Main.SemanticDelta
open Main.SemanticDirectoryCatalog
open CWTools.Utilities.Utils
open CWTools.Localisation
open LSP.LanguageServer   // brings gameStateLock into scope

// Precompile regular to avoid InlayHint / precache allocation every time on the hot path
let private inlayLocalVarPattern =
    System.Text.RegularExpressions.Regex(
        @"^\s*(@[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n\r#]+)",
        System.Text.RegularExpressions.RegexOptions.Multiline ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private inlayVarNamePattern =
    System.Text.RegularExpressions.Regex(
        "[a-zA-Z_][a-zA-Z0-9_]*",
        System.Text.RegularExpressions.RegexOptions.Compiled)

// Replace whole-word occurrences of `word` in `text` (identifier boundaries only).
let private replaceWholeWordInlay (text: string) (word: string) (replacement: string) =
    let sb = System.Text.StringBuilder()
    let mutable last = 0
    let mutable replaced = false
    let isWordChar (c: char) = System.Char.IsLetterOrDigit c || c = '_'
    for m in inlayVarNamePattern.Matches(text) do
        if m.Value = word then
            let boundaryBefore = m.Index = 0 || not (isWordChar text.[m.Index - 1])
            let endIndex = m.Index + m.Length
            let boundaryAfter = endIndex >= text.Length || not (isWordChar text.[endIndex])
            if boundaryBefore && boundaryAfter then
                sb.Append(text.Substring(last, m.Index - last)) |> ignore
                sb.Append(replacement) |> ignore
                last <- endIndex
                replaced <- true
    if replaced then (sb.Append(text.Substring(last)).ToString()) else text

let private definitionInjectionKeyPattern =
    System.Text.RegularExpressions.Regex(
        @"^\s*(INJECT|REPLACE|TRY_INJECT|TRY_REPLACE|INJECT_OR_CREATE|REPLACE_OR_CREATE):([A-Za-z0-9_.:-]+)\s*=",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private inlineScriptParameterPattern =
    System.Text.RegularExpressions.Regex(
        @"\$[A-Za-z0-9_.:-]+(?:\|[A-Za-z0-9_.:-]+)?\$|\|[A-Za-z0-9_.:-]+\|",
        System.Text.RegularExpressions.RegexOptions.Compiled)

type private SemanticValueReference =
    { argumentPath: string
      access: string
      typeName: string }

type private SemanticRuleInfo =
    { name: string
      category: string
      supportedScopes: string list
      pushScope: string option
      valueReferences: SemanticValueReference list }

type private SemanticDefinitionReferenceInfo =
    { definitionName: string
      reference: SemanticValueReference }

type private SemanticShaderReference =
    { argumentPath: string
      referenceKind: string
      dynamicValuePolicy: string
      pathPrefix: string option
      extension: string option }

type private SemanticDefinitionShaderReferenceInfo =
    { definitionName: string
      reference: SemanticShaderReference }

let private semanticAliasPattern =
    System.Text.RegularExpressions.Regex(
        @"^\s*alias\[(trigger|effect|modifier):([^\]]+)\]\s*=\s*(.*)$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private semanticDirectivePattern =
    System.Text.RegularExpressions.Regex(
        @"^\s*##\s*([A-Za-z_]+)\s*=\s*(.*)$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private semanticAssignmentPattern =
    System.Text.RegularExpressions.Regex(
        @"^\s*(alias\[(?:trigger|effect|modifier):[^\]]+\]|[A-Za-z_][\w.-]*)\s*=\s*(.*)$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private semanticTypedValuePattern =
    System.Text.RegularExpressions.Regex(
        @"^(value_set|value|scope)\[([^\]]+)\]",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private semanticEntityTypePattern =
    System.Text.RegularExpressions.Regex(
        @"^<([^>]+)>",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private semanticShaderFilePattern =
    System.Text.RegularExpressions.Regex(
        @"^filepath\[\s*([^,\]]*)\s*(?:,\s*([^\]]*)\s*)?\]$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private semanticDynamicSchemaKeyPattern =
    System.Text.RegularExpressions.Regex(
        @"^(?:(?:int|float|scalar|bool|date|localisation|value_field|percent)(?:\[.*\])?|<[^>]+>|enum\[.*\]|value(?:_set)?\[.*\]|scope\[.*\])$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private splitSemanticDirectiveValues (value: string) =
    value.Trim().TrimStart('{').TrimEnd('}')
        .Split([| ' '; '\t'; '\r'; '\n' |], StringSplitOptions.RemoveEmptyEntries)
    |> Array.map (fun item -> item.Trim().Trim('"').ToLowerInvariant())
    |> Array.filter (String.IsNullOrWhiteSpace >> not)
    |> Array.toList

let private semanticRulesFromConfigs (requestedNames: string list) (configs: (string * string) list) =
    let requested = System.Collections.Generic.HashSet<string>(requestedNames, StringComparer.OrdinalIgnoreCase)
    let rules = ResizeArray<SemanticRuleInfo>()

    for fileName, content in configs |> List.sortBy fst do
        let lines = content.Replace("\r\n", "\n").Split('\n')
        let scopeChangeFile =
            fileName.Replace('\\', '/').Contains("scope_changes", StringComparison.OrdinalIgnoreCase)
        let mutable supportedScopes: string list = []
        let mutable pushScope: string option = None
        let mutable index = 0

        while index < lines.Length do
            let line = lines.[index]
            let directive = semanticDirectivePattern.Match(line)
            if directive.Success then
                match directive.Groups.[1].Value.ToLowerInvariant() with
                | "scope"
                | "supported_scopes" -> supportedScopes <- splitSemanticDirectiveValues directive.Groups.[2].Value
                | "push_scope" -> pushScope <- splitSemanticDirectiveValues directive.Groups.[2].Value |> List.tryHead
                | _ -> ()

            let aliasMatch = semanticAliasPattern.Match(line)
            if not aliasMatch.Success then
                index <- index + 1
            else
                let name = aliasMatch.Groups.[2].Value.ToLowerInvariant()
                let mutable endIndex = index
                let mutable depth = 0
                let mutable opened = false
                let mutable scanning = true
                while scanning && endIndex < lines.Length do
                    let uncommented = lines.[endIndex].Split('#').[0]
                    for char in uncommented do
                        if char = '{' then
                            opened <- true
                            depth <- depth + 1
                        elif char = '}' then
                            depth <- depth - 1
                    if (not opened) || depth <= 0 then scanning <- false
                    else endIndex <- endIndex + 1

                if requested.Count = 0 || requested.Contains name then
                    let references = ResizeArray<SemanticValueReference>()
                    for lineIndex in index .. min endIndex (lines.Length - 1) do
                        let assignment = semanticAssignmentPattern.Match(lines.[lineIndex].Split('#').[0])
                        if assignment.Success then
                            let left = assignment.Groups.[1].Value
                            let argumentPath =
                                if left.StartsWith("alias[", StringComparison.OrdinalIgnoreCase) then "$value" else left
                            let rhs = assignment.Groups.[2].Value.Trim()
                            let typed = semanticTypedValuePattern.Match(rhs)
                            if typed.Success then
                                references.Add(
                                    { argumentPath = argumentPath
                                      access = typed.Groups.[1].Value.ToLowerInvariant()
                                      typeName = typed.Groups.[2].Value.Trim().ToLowerInvariant() })
                            else
                                let entityType = semanticEntityTypePattern.Match(rhs)
                                if entityType.Success then
                                    references.Add(
                                        { argumentPath = argumentPath
                                          access = "type"
                                          typeName = entityType.Groups.[1].Value.Trim().ToLowerInvariant() })

                    let category =
                        if scopeChangeFile then "scope_change" else aliasMatch.Groups.[1].Value.ToLowerInvariant()
                    rules.Add(
                        { name = name
                          category = category
                          supportedScopes = supportedScopes
                          pushScope = pushScope
                          valueReferences = references |> Seq.distinctBy (fun item -> item.argumentPath.ToLowerInvariant(), item.access, item.typeName) |> Seq.truncate 32 |> Seq.toList })

                supportedScopes <- []
                pushScope <- None
                index <- max (index + 1) (endIndex + 1)

    let contentForHash =
        configs
        |> List.sortBy fst
        |> List.map (fun (fileName, content) -> fileName + "\u0000" + content)
        |> String.concat "\u0001"
    use sha = System.Security.Cryptography.SHA256.Create()
    let hash =
        sha.ComputeHash(Encoding.UTF8.GetBytes(contentForHash))
        |> Convert.ToHexString
        |> fun value -> value.Substring(0, 16).ToLowerInvariant()
    rules |> Seq.toList, hash

let private semanticDefinitionReferencesFromConfigs (configs: (string * string) list) =
    let references = ResizeArray<SemanticDefinitionReferenceInfo>()
    let shaderReferences = ResizeArray<SemanticDefinitionShaderReferenceInfo>()
    let normalizeKey (value: string) =
        let normalized = value.Trim().Trim('"').ToLowerInvariant()
        if semanticDynamicSchemaKeyPattern.IsMatch normalized then "*" else normalized
    let tryEntityType (rawValue: string) =
        let matched = semanticEntityTypePattern.Match(rawValue.Trim())
        if matched.Success then Some(matched.Groups.[1].Value.Trim().ToLowerInvariant()) else None
    let tryShaderReference (rawValue: string) =
        let normalized = rawValue.Trim()
        if normalized.Equals("$shader_effect", StringComparison.OrdinalIgnoreCase) then
            Some("shader_effect", "allow_expression", None, None)
        else
            let matched = semanticShaderFilePattern.Match normalized
            if matched.Success then
                let pathPrefix = matched.Groups.[1].Value.Trim()
                let extension = matched.Groups.[2].Value.Trim()
                if extension.Equals(".shader", StringComparison.OrdinalIgnoreCase) then
                    Some(
                        "shader_file",
                        "literal_or_parameter",
                        (if String.IsNullOrWhiteSpace pathPrefix then None else Some pathPrefix),
                        Some extension
                    )
                else
                    None
            else
                None

    for fileName, content in configs |> List.sortBy fst do
        match CKParser.parseString content fileName with
        | Failure _ -> ()
        | Success(statements, _, _) ->
            let rootNode =
                CWTools.Process.STLProcess.simpleProcess.ProcessNode () "root" (mkZeroFile fileName) statements
            for schema in rootNode.Nodes do
                let definitionName = schema.Key.Trim().Trim('"').ToLowerInvariant()
                let rec walk (path: string list) (node: CWTools.Process.Node) =
                    for leaf in node.Leaves do
                        let argumentPath = String.concat "." (path @ [ normalizeKey leaf.Key ])
                        match tryEntityType (leaf.Value.ToRawString()) with
                        | Some typeName ->
                            references.Add {
                                definitionName = definitionName
                                reference = {
                                    argumentPath = argumentPath
                                    access = "type"
                                    typeName = typeName
                                }
                            }
                        | None -> ()
                        match tryShaderReference (leaf.Value.ToRawString()) with
                        | Some(referenceKind, dynamicValuePolicy, pathPrefix, extension) ->
                            shaderReferences.Add {
                                definitionName = definitionName
                                reference = {
                                    argumentPath = argumentPath
                                    referenceKind = referenceKind
                                    dynamicValuePolicy = dynamicValuePolicy
                                    pathPrefix = pathPrefix
                                    extension = extension
                                }
                            }
                        | None -> ()
                    for leafValue in node.LeafValues do
                        match tryEntityType (leafValue.Value.ToRawString()) with
                        | Some typeName ->
                            references.Add {
                                definitionName = definitionName
                                reference = {
                                    argumentPath = String.concat "." (path @ [ "$value" ])
                                    access = "type"
                                    typeName = typeName
                                }
                            }
                        | None -> ()
                    for child in node.Nodes do
                        walk (path @ [ normalizeKey child.Key ]) child
                walk [] schema

    let valueReferences =
        references
        |> Seq.distinctBy (fun item ->
            item.definitionName,
            item.reference.argumentPath,
            item.reference.access,
            item.reference.typeName)
        |> Seq.truncate 100_000
        |> Seq.toList
    let shaderReferences =
        shaderReferences
        |> Seq.distinctBy (fun item ->
            item.definitionName,
            item.reference.argumentPath,
            item.reference.referenceKind,
            item.reference.dynamicValuePolicy,
            item.reference.pathPrefix,
            item.reference.extension)
        |> Seq.truncate 10_000
        |> Seq.toList
    valueReferences, shaderReferences

type private DefinitionInjectionKeyInfo =
    { mode: string
      target: string
      line: int
      keyStart: int
      keyEnd: int
      modeStart: int
      modeEnd: int
      targetStart: int
      targetEnd: int }

let private tryDefinitionInjectionKeyAtLine (fileText: string) (line: int) =
    let lines = fileText.Replace("\r\n", "\n").Split('\n')
    if line < 0 || line >= lines.Length then
        None
    else
        let lineText = lines.[line]
        let m = definitionInjectionKeyPattern.Match(lineText)
        if not m.Success then
            None
        else
            let modeGroup = m.Groups.[1]
            let targetGroup = m.Groups.[2]
            Some
                { mode = modeGroup.Value.ToUpperInvariant()
                  target = targetGroup.Value
                  line = line
                  keyStart = modeGroup.Index
                  keyEnd = targetGroup.Index + targetGroup.Length
                  modeStart = modeGroup.Index
                  modeEnd = modeGroup.Index + modeGroup.Length
                  targetStart = targetGroup.Index
                  targetEnd = targetGroup.Index + targetGroup.Length }

let private tryFindDefinitionInjectionTarget (game: IGame) (target: string) =
    game.Types()
    |> Map.toSeq
    |> Seq.collect (fun (typeName, infos) ->
        infos
        |> Seq.choose (fun tdi ->
            if String.Equals(tdi.id, target, StringComparison.OrdinalIgnoreCase) then
                Some(typeName, tdi)
            else
                None))
    |> Seq.sortBy (fun (typeName, tdi) -> tdi.range.FileName, typeName)
    |> Seq.tryHead

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

let private localisationHeaderPattern =
    System.Text.RegularExpressions.Regex(
        @"^\s*\uFEFF?(l_[A-Za-z0-9_]+)\s*:\s*(#.*)?$",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private localisationEntryPattern =
    System.Text.RegularExpressions.Regex(
        @"^(\s*)([^\s:#][^:\s]*)\s*:\s*(\d*)\s*(.*)$",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private splitLines (text: string) =
    System.Text.RegularExpressions.Regex.Split(text, "\r\n|\n|\r")

let private detectLineEnding (text: string) =
    if text.Contains("\r\n") then "\r\n"
    elif text.Contains("\r") then "\r"
    else "\n"

let private getFormattingIndent (options: DocumentFormattingOptions) =
    if options.insertSpaces then
        String.replicate (max 1 options.tabSize) " "
    else
        "\t"

let private looksLikeLocalisationYaml (lines: string array) =
    let rec loop index =
        if index >= lines.Length then
            false
        else
            let trimmed = lines.[index].Trim()

            if String.IsNullOrEmpty trimmed || trimmed.StartsWith("#") then
                loop (index + 1)
            else
                localisationHeaderPattern.IsMatch(lines.[index])

    loop 0

let private formatLocalisationYaml (options: DocumentFormattingOptions) (text: string) =
    let lines = splitLines text

    if not (looksLikeLocalisationYaml lines) then
        None
    else
        let indent = getFormattingIndent options
        let mutable sawHeader = false

        let formattedLines =
            lines
            |> Array.map (fun line ->
                let trimmedRight = line.TrimEnd()
                let headerMatch = localisationHeaderPattern.Match(trimmedRight)

                if headerMatch.Success then
                    sawHeader <- true
                    let language = headerMatch.Groups.[1].Value

                    let suffix =
                        if headerMatch.Groups.[2].Success then
                            " " + headerMatch.Groups.[2].Value.Trim()
                        else
                            ""

                    language + ":" + suffix
                elif sawHeader then
                    if String.IsNullOrWhiteSpace trimmedRight then
                        ""
                    else
                        let trimmedStart = trimmedRight.TrimStart()

                        if trimmedStart.StartsWith("#") then
                            // Loc YAML is flat: every line under the header sits at one level.
                            indent + trimmedStart
                        else
                            let entryMatch = localisationEntryPattern.Match(trimmedRight)

                            if entryMatch.Success then
                                let key = entryMatch.Groups.[2].Value
                                let version = entryMatch.Groups.[3].Value
                                let value = entryMatch.Groups.[4].Value.Trim()
                                let prefix = if String.IsNullOrEmpty version then key + ":" else key + ":" + version

                                if String.IsNullOrEmpty value then
                                    indent + prefix
                                else
                                    indent + prefix + " " + value
                            else
                                trimmedRight
                else
                    trimmedRight)

        let formatted = String.Join(detectLineEnding text, formattedLines)
        if formatted = text then None else Some formatted

let private isLocalisationDefinitionPath (filePath: string) =
    let normalized = filePath.Replace('\\', '/').ToLowerInvariant()
    normalized.EndsWith(".yml")
    || normalized.Contains("/localisation/")
    || normalized.Contains("/localization/")

let private isNavigableDefinitionRange (r: range) =
    r.StartLine > 0
    && r.EndLine > 0
    && not (String.IsNullOrWhiteSpace r.FileName)

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
            [ "common"; "events"; "interface"; "gfx"; "localisation"
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

// Path equality: case-insensitive on Windows (case-insensitive FS), case-sensitive on
// Linux/macOS, mirroring the filesystem. Use ONLY for filesystem path comparisons,
// NOT for PDX symbol/identifier matching (those stay OrdinalIgnoreCase, engine-mirrored).
let private pathComparison =
    if RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
    then StringComparison.OrdinalIgnoreCase
    else StringComparison.Ordinal

let private isAllowedDefinitionTarget (sourcePath: string) (targetPath: string) =
    match tryFindProjectRoot sourcePath, tryFindProjectRoot targetPath with
    | Some sourceRoot, Some targetRoot ->
        String.Equals(sourceRoot, targetRoot, pathComparison)
    | _ -> true

let private normalizeDefinitionSymbol (symbol: string) =
    symbol.Trim().Trim('"')

let private scriptedVariableNamePattern =
    System.Text.RegularExpressions.Regex(
        @"^@?[A-Za-z_][A-Za-z0-9_$]*$",
        System.Text.RegularExpressions.RegexOptions.Compiled)

let private scriptedVariableDefinitionPattern =
    System.Text.RegularExpressions.Regex(
        @"^\s*(@[A-Za-z_][A-Za-z0-9_$]*)\s*=",
        System.Text.RegularExpressions.RegexOptions.Multiline ||| System.Text.RegularExpressions.RegexOptions.Compiled)

let private tryScriptedVariableNameFromSymbol (symbol: string) =
    let normalized = normalizeDefinitionSymbol symbol
    if scriptedVariableNamePattern.IsMatch normalized then
        if normalized.StartsWith("@", StringComparison.Ordinal) then
            Some normalized
        else
            Some("@" + normalized)
    else
        None

let private rangeFromTextSpan filePath (text: string) start length =
    let safeStart = max 0 (min start text.Length)
    let safeLength = max 0 (min length (text.Length - safeStart))
    let before = text.Substring(0, safeStart)
    let line = (before |> Seq.filter ((=) '\n') |> Seq.length) + 1
    let lastLineBreak = before.LastIndexOf('\n')
    let column = if lastLineBreak < 0 then safeStart else safeStart - lastLineBreak - 1
    mkRange filePath (mkPos line column) (mkPos line (column + safeLength))

let private tryScriptedVariableDefinitionInText filePath (text: string) (variableName: string) =
    scriptedVariableDefinitionPattern.Matches(text)
    |> Seq.cast<System.Text.RegularExpressions.Match>
    |> Seq.tryPick (fun m ->
        let nameGroup = m.Groups.[1]
        if String.Equals(nameGroup.Value, variableName, StringComparison.OrdinalIgnoreCase) then
            Some(rangeFromTextSpan filePath text nameGroup.Index nameGroup.Length)
        else
            None)

let private isScriptedVariablesPath (filePath: string) (logicalPath: string) =
    let isMatch (pathValue: string) =
        let normalized = pathValue.Replace('\\', '/')
        normalized.Contains("common/scripted_variables/", StringComparison.OrdinalIgnoreCase)

    isMatch filePath || isMatch logicalPath

let private tryScriptValueNameFromSymbol (symbol: string) =
    let valuePrefix = "value:"
    let normalized = normalizeDefinitionSymbol symbol
    if normalized.StartsWith(valuePrefix, StringComparison.OrdinalIgnoreCase) then
        let valueName = normalized.Substring(valuePrefix.Length)
        let pipeIndex = valueName.IndexOf('|')
        let valueName =
            if pipeIndex >= 0 then valueName.Substring(0, pipeIndex)
            else valueName

        if String.IsNullOrWhiteSpace valueName then None else Some valueName
    else
        None

let private trimLocalisationKey (value: string) =
    value.Trim().Trim('"')

let private withUppercaseModifierFallback (candidates: string list) =
    candidates
    |> List.collect (fun candidate ->
        let candidate = trimLocalisationKey candidate
        if String.IsNullOrWhiteSpace candidate then
            []
        elif candidate.StartsWith("mod_", StringComparison.OrdinalIgnoreCase) then
            let upperCandidate = candidate.ToUpperInvariant()
            if String.Equals(candidate, upperCandidate, StringComparison.Ordinal) then
                [ candidate ]
            else
                [ candidate; upperCandidate ]
        else
            [ candidate ])
    |> List.distinct

let private typeLocalisationDefinitions
    (typeDefsByName: Map<string, TypeDefinition>)
    (typeName: string)
    (tdi: TypeDefInfo)
    =
    let parts = typeName.Split([|'.'|], 2)
    let baseTypeName = parts.[0]

    match Map.tryFind baseTypeName typeDefsByName with
    | None -> []
    | Some typeDef ->
        let subtypeNames =
            [ if parts.Length > 1 then yield parts.[1]
              yield! tdi.subtypes ]
            |> List.distinct

        let subtypeLocs =
            subtypeNames
            |> List.collect (fun subtypeName ->
                typeDef.subtypes
                |> List.tryFind (fun st -> String.Equals(st.name, subtypeName, StringComparison.OrdinalIgnoreCase))
                |> Option.map (fun st -> st.localisation)
                |> Option.defaultValue [])

        typeDef.localisation @ subtypeLocs

let private typeLocalisationKeysForSymbol
    (typeDefsByName: Map<string, TypeDefinition>)
    (typeName: string)
    (tdi: TypeDefInfo)
    (key: string)
    =
    typeLocalisationDefinitions typeDefsByName typeName tdi
    |> List.choose (fun locDef ->
        if locDef.explicitField.IsSome then
            None
        else
            Some(locDef.prefix + key + locDef.suffix))
    |> withUppercaseModifierFallback

let private typeLocalisationRenamePairs
    (typeDefsByName: Map<string, TypeDefinition>)
    (typeName: string)
    (tdi: TypeDefInfo)
    (oldKey: string)
    (newKey: string)
    =
    typeLocalisationDefinitions typeDefsByName typeName tdi
    |> List.collect (fun locDef ->
        if locDef.explicitField.IsSome then
            []
        else
            let oldLocKey = trimLocalisationKey (locDef.prefix + oldKey + locDef.suffix)
            let newLocKey = trimLocalisationKey (locDef.prefix + newKey + locDef.suffix)
            if String.IsNullOrWhiteSpace oldLocKey
               || String.Equals(oldLocKey, newLocKey, StringComparison.Ordinal) then
                []
            else
                withUppercaseModifierFallback [ oldLocKey ]
                |> List.map (fun oldVariant ->
                    let newVariant =
                        if oldVariant.StartsWith("MOD_", StringComparison.Ordinal) then
                            newLocKey.ToUpperInvariant()
                        else
                            newLocKey

                    oldVariant, newVariant))
    |> List.distinct

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
                    || c = '$'
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
        let fromScriptValue =
            tryScriptValueNameFromSymbol needle
            |> Option.bind (fun scriptValueName ->
                typeMap
                |> Map.tryFind "script_value"
                |> Option.defaultValue [||]
                |> Array.tryPick (fun tdi ->
                    if isCodeRange tdi.range
                       && String.Equals(tdi.id, scriptValueName, StringComparison.OrdinalIgnoreCase) then
                        Some tdi.range
                    else
                        None))

        let fromTypes =
            fromScriptValue
            |> Option.orElseWith (fun () ->
                typeMap
                |> Map.toSeq
                |> Seq.tryPick (fun (_, infos) ->
                    infos
                    |> Array.tryPick (fun tdi ->
                        if isCodeRange tdi.range && sameSymbol tdi.id then Some tdi.range else None)))

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

let private tryTypeDefinitionBySymbol (game: IGame) (sourcePath: string) (typeNames: string list) (symbol: string) =
    let needle = normalizeDefinitionSymbol symbol
    let sameSymbol value =
        String.Equals(normalizeDefinitionSymbol value, needle, StringComparison.OrdinalIgnoreCase)
    let isAllowedType typeName =
        typeNames |> List.exists (fun allowed -> String.Equals(typeName, allowed, StringComparison.OrdinalIgnoreCase))
    let isCodeRange (r: range) =
        isNavigableDefinitionRange r
        && not (isLocalisationDefinitionPath r.FileName)
        && isAllowedDefinitionTarget sourcePath r.FileName

    if String.IsNullOrWhiteSpace needle then None
    else
        game.Types()
        |> Map.toSeq
        |> Seq.filter (fun (typeName, _) -> isAllowedType typeName)
        |> Seq.tryPick (fun (_, infos) ->
            infos
            |> Array.tryPick (fun tdi ->
                if isCodeRange tdi.range && sameSymbol tdi.id then Some tdi.range else None))

let private isKnownSyntheticModifierSymbol (game: IGame) (symbol: string) =
    let needle = normalizeDefinitionSymbol symbol
    if String.IsNullOrWhiteSpace needle then
        false
    else
        game.Types()
        |> Map.tryFind "modifier"
        |> Option.defaultValue [||]
        |> Array.exists (fun tdi ->
            String.Equals(normalizeDefinitionSymbol tdi.id, needle, StringComparison.OrdinalIgnoreCase)
            && not (isNavigableDefinitionRange tdi.range))

let private tryScriptedVariableDefinitionBySymbol
    (gameDispatcher: IGameDispatcher)
    (game: IGame)
    (sourcePath: string)
    (sourceText: string)
    (symbol: string)
    =
    let rec tryFindInNode (variableName: string) (node: CWTools.Process.Node) =
        node.Leaves
        |> Seq.tryPick (fun leaf ->
            if String.Equals(leaf.Key, variableName, StringComparison.OrdinalIgnoreCase)
               && isNavigableDefinitionRange leaf.Position then
                Some leaf.Position
            else
                None)
        |> Option.orElseWith (fun () ->
            node.Nodes |> Seq.tryPick (tryFindInNode variableName))

    tryScriptedVariableNameFromSymbol symbol
    |> Option.bind (fun variableName ->
        tryScriptedVariableDefinitionInText sourcePath sourceText variableName
        |> Option.orElseWith (fun () ->
            let hasGlobalDefinition =
                game.ScriptedVariables()
                |> List.exists (fun (name, _) -> String.Equals(name, variableName, StringComparison.OrdinalIgnoreCase))

            if not hasGlobalDefinition then
                None
            else
                let visitor =
                    { new IGameVisitor<_> with
                        member _.Visit game =
                            game.AllEntities()
                            |> Seq.tryPick (fun struct (entity, _) ->
                                if isScriptedVariablesPath entity.filepath entity.logicalpath
                                   && isAllowedDefinitionTarget sourcePath entity.filepath then
                                    tryFindInNode variableName entity.entity
                                else
                                    None) }

                gameDispatcher.Dispatch visitor |> Option.flatten))

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
        |> Option.bind (fun symbol ->
            tryScriptedVariableDefinitionBySymbol gameDispatcher game sourcePath sourceText symbol
            |> Option.orElseWith (fun () -> tryTypeDefinitionBySymbol game sourcePath [ "scripted_action" ] symbol)
            |> Option.orElseWith (fun () ->
                if isKnownSyntheticModifierSymbol game symbol then
                    None
                else
                    tryCodeDefinitionBySymbol gameDispatcher game sourcePath symbol))
    | Some target when isLocalisationDefinitionPath target.FileName ->
        // GoToType already resolved to a loc file - return it directly.
        candidate
    | None ->
        tryDefinitionSymbolAt sourceText line character
        |> Option.bind (fun symbol ->
            tryScriptedVariableDefinitionBySymbol gameDispatcher game sourcePath sourceText symbol
            |> Option.orElseWith (fun () -> tryTypeDefinitionBySymbol game sourcePath [ "scripted_action" ] symbol)
            |> Option.orElseWith (fun () ->
                if tryScriptValueNameFromSymbol symbol |> Option.isSome then
                    tryCodeDefinitionBySymbol gameDispatcher game sourcePath symbol
                else
                    None))
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

type LintRequestOptions =
    { forceDeepLint: bool
      forceGlobalRefresh: bool
      fastDefinitionIndex: bool
      forceDisk: bool
      preparedRetryCount: int }

let normalLintRequest =
    { forceDeepLint = false
      forceGlobalRefresh = false
      fastDefinitionIndex = false
      forceDisk = false
      preparedRetryCount = 0 }

let deepLintRequest =
    { forceDeepLint = true
      forceGlobalRefresh = false
      fastDefinitionIndex = false
      forceDisk = false
      preparedRetryCount = 0 }

let fastDefinitionIndexRequest =
    { forceDeepLint = false
      forceGlobalRefresh = false
      fastDefinitionIndex = true
      forceDisk = false
      preparedRetryCount = 0 }

/// A file-system or agent write must replace the CWTools VFS entry from disk,
/// even when the file is not in a type-defining directory.
let diskRefreshRequest =
    { forceDeepLint = true
      forceGlobalRefresh = false
      fastDefinitionIndex = false
      forceDisk = true
      preparedRetryCount = 0 }

let mergeLintRequestOptions a b =
    { forceDeepLint = a.forceDeepLint || b.forceDeepLint
      forceGlobalRefresh = a.forceGlobalRefresh || b.forceGlobalRefresh
      fastDefinitionIndex = a.fastDefinitionIndex || b.fastDefinitionIndex
      forceDisk = a.forceDisk || b.forceDisk
      // A real editor request has count zero and must reset the budget of an
      // older queued retry for the same path.
      preparedRetryCount = min a.preparedRetryCount b.preparedRetryCount }

let maxPreparedCommitRetries = 2

type LintRequestMsg =
    | UpdateRequest of VersionedTextDocumentIdentifier * LintRequestOptions
    | OpenRequest of VersionedTextDocumentIdentifier
    | WorkComplete of DateTime

type private IncrementalTypeStage =
    | ScriptedServices of StagedScriptedTypes
    | TypeIndexOnly of IIncrementalTypeIndex * StagedTypeIndex

/// Shared token computation - walks AST, classifies tokens, encodes to delta int[].
let computeShaderTokens
    (cancellationToken: System.Threading.CancellationToken)
    (_game: IGame<_>)
    (filePath: string)
    (fileText: string)
    =
    cancellationToken.ThrowIfCancellationRequested()
    let tokenTypeIndex =
        Map.ofList
            [ "namespace", 0
              "type", 1
              "function", 2
              "variable", 3
              "parameter", 4
              "property", 5
              "enumMember", 6
              "keyword", 7
              "number", 8
              "string", 9
              "comment", 10
              "operator", 11
              "macro", 12
              "decorator", 13 ]
    let lineStarts = ResizeArray<int>()
    lineStarts.Add 0
    for offset = 0 to fileText.Length - 1 do
        if offset % 4096 = 0 then cancellationToken.ThrowIfCancellationRequested()
        if fileText.[offset] = '\n' then lineStarts.Add(offset + 1)

    let lineAndColumn offset =
        let bounded = max 0 (min fileText.Length offset)
        let mutable low = 0
        let mutable high = lineStarts.Count - 1
        while low < high do
            let middle = (low + high + 1) / 2
            if lineStarts.[middle] <= bounded then low <- middle else high <- middle - 1
        low, bounded - lineStarts.[low]

    let tokens = ResizeArray<struct (int * int * int * int * int)>()
    for token in PdxShaderFeatures.semanticTokens filePath fileText do
        cancellationToken.ThrowIfCancellationRequested()
        match Map.tryFind token.tokenType tokenTypeIndex with
        | None -> ()
        | Some tokenType ->
            let modifiers =
                (if token.declaration then 1 else 0)
                ||| (if token.readonly then 4 else 0)
                ||| (if token.inactive then 8 else 0)
            let mutable startOffset = token.span.startOffset
            let endOffset = min fileText.Length token.span.endOffset
            while startOffset < endOffset do
                let line, column = lineAndColumn startOffset
                let nextLineStart = if line + 1 < lineStarts.Count then lineStarts.[line + 1] else fileText.Length
                let segmentEnd = min endOffset nextLineStart
                let mutable segmentLength = segmentEnd - startOffset
                if segmentLength > 0 && fileText.[startOffset + segmentLength - 1] = '\n' then segmentLength <- segmentLength - 1
                if segmentLength > 0 && fileText.[startOffset + segmentLength - 1] = '\r' then segmentLength <- segmentLength - 1
                if segmentLength > 0 then tokens.Add(struct (line, column, segmentLength, tokenType, modifiers))
                startOffset <- max (startOffset + 1) segmentEnd

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

let computeScriptTokens
    (cancellationToken: System.Threading.CancellationToken)
    (rootNodeOpt: CWTools.Process.Node option)
    (allEffects: System.Collections.Generic.HashSet<string>)
    (allTriggers: System.Collections.Generic.HashSet<string>)
    (filePath: string)
    (fileText: string)
    =
    cancellationToken.ThrowIfCancellationRequested()
    match rootNodeOpt with
    | None -> [||]
    | Some rootNode ->
        let tokens = ResizeArray<struct (int * int * int * int * int)>()
        let lines = fileText.Split('\n')
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
        let addValueTokens (line: int) (col: int) (value: string) (fallbackTokenType: int) =
            let matches = inlineScriptParameterPattern.Matches(value)
            if matches.Count = 0 then
                verifyAndAdd line col value.Length fallbackTokenType
            else
                let mutable segmentStart = 0
                for i = 0 to matches.Count - 1 do
                    let m = matches.[i]
                    if m.Index > segmentStart then
                        verifyAndAdd line (col + segmentStart) (m.Index - segmentStart) fallbackTokenType
                    let tokenType =
                        if m.Value.StartsWith("$", StringComparison.Ordinal) then 4
                        else 12
                    if tokenType = 4 then
                        verifyAndAdd line (col + m.Index) m.Length tokenType
                    else
                        verifyAndAdd line (col + m.Index + 1) (m.Length - 2) tokenType
                    segmentStart <- m.Index + m.Length
                if segmentStart < value.Length then
                    verifyAndAdd line (col + segmentStart) (value.Length - segmentStart) fallbackTokenType
        let rec visitNode (n: CWTools.Process.Node) =
            cancellationToken.ThrowIfCancellationRequested()
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
                                addValueTokens valLine actualValCol searchVal valType
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
                        addValueTokens line col (rawVal.Trim('"')) valType
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
        visitNode rootNode
        lines |> Array.iteri (fun lineIdx lineText ->
            if lineIdx % 64 = 0 then cancellationToken.ThrowIfCancellationRequested()
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

let computeTokensForFile
    (cancellationToken: System.Threading.CancellationToken)
    (game: IGame<_>)
    (allEffects: System.Collections.Generic.HashSet<string>)
    (allTriggers: System.Collections.Generic.HashSet<string>)
    (filePath: string)
    (fileText: string)
    =
    let isShaderFile (path: string) =
        let ext = System.IO.Path.GetExtension(path)
        ext.Equals(".shader", System.StringComparison.OrdinalIgnoreCase) || ext.Equals(".fxh", System.StringComparison.OrdinalIgnoreCase)
        
    if isShaderFile filePath then
        computeShaderTokens cancellationToken game filePath fileText
    else
        let rootNode =
            match CKParser.parseString fileText filePath with
            | Failure _ -> None
            | Success(statements, _, _) ->
                Some(CWTools.Process.STLProcess.simpleProcess.ProcessNode () "root" (mkZeroFile filePath) statements)

        computeScriptTokens cancellationToken rootNode allEffects allTriggers filePath fileText


//-Diagnostic freshness state machine-
// After AI writes the file, it uses epoch + freshness to determine whether the current diagnosis corresponds to the latest file version
type DiagnosticFreshness =
    | Fresh      // Grammar + rules + global verification are completed
    | Pending    // Single file verification completed, global verification (types/localisation) is still queued
    | Stale      // No verification has been run on this version yet

type ValidationModelEpoch =
    { game: int64
      rules: int64
      types: int64
      localisation: int64 }

type FileDiagnosticState =
    { version: int option             // Document version (from DidChange)
      validatedVersion: int option    // Document version that produced these diagnostics
      epoch: int64                     // Increment the counter, lint +1 each time
      updatedAtUnixMs: int64           //Unix millisecond timestamp
      freshness: DiagnosticFreshness   // current status
      pendingGlobalKinds: string list  // For example ["localisation"; "types"]
      modelEpoch: ValidationModelEpoch // Shared model snapshot used by this validation
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
      lastRulesSource: string
      lastCacheStatus: string
      lastPrecacheFileCount: int
      lastError: string option }

type CompletionRuntimeState =
    { totalRequests: int
      cacheHits: int
      cacheMisses: int
      lockTimeoutFallbacks: int
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

/// Validation/completion-visible contribution of a file change is defined in
/// SemanticDelta.fs. Path routing identifies the candidate domains; exact type
/// keys and semantic equality are supplied by the staged CWTools type index
/// before a global refresh is queued.

type Server(client: ILanguageClient) =
    do setupLogger client
    let serverProcessId = Environment.ProcessId
    let serverInstanceId =
        match Environment.GetEnvironmentVariable("CWTOOLS_SERVER_INSTANCE_ID") with
        | value when not (String.IsNullOrWhiteSpace value) -> value.Trim()
        | _ -> Guid.NewGuid().ToString("N")
    let lifecycleIdentity = $"pid={serverProcessId} instance={serverInstanceId}"
    let docs = DocumentStore()
    let dirtyDocumentPaths = System.Collections.Concurrent.ConcurrentDictionary<string, byte>()
    let latestLintGenerations = System.Collections.Concurrent.ConcurrentDictionary<string, int64>()
    /// Exact document versions whose incremental type stage has committed. A
    /// subsequent Ctrl+S for the same version can deep-validate without staging
    /// the identical type/enum update a second time.
    let committedTypeIndexVersions =
        System.Collections.Concurrent.ConcurrentDictionary<string, struct (int * IGame)>()
    let committedInteractiveVersions =
        System.Collections.Concurrent.ConcurrentDictionary<string, struct (int * IGame)>()

    let lintGenerationKey filePath =
        let fullPath =
            try FileInfo(filePath).FullName.Replace('\\', '/')
            with _ -> filePath.Replace('\\', '/')
        if OperatingSystem.IsWindows() then fullPath.ToLowerInvariant() else fullPath

    let advanceLintGeneration filePath =
        latestLintGenerations.AddOrUpdate(lintGenerationKey filePath, 1L, fun _ current -> current + 1L)

    let lintGeneration filePath =
        match latestLintGenerations.TryGetValue(lintGenerationKey filePath) with
        | true, generation -> generation
        | false, _ -> 0L

    let releaseLintGeneration filePath generation =
        let entry =
            System.Collections.Generic.KeyValuePair<string, int64>(lintGenerationKey filePath, generation)
        (latestLintGenerations :> System.Collections.Generic.ICollection<_>).Remove(entry) |> ignore

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
    let mutable gameModelEpoch = 0L
    let mutable rulesModelEpoch = 0L
    let mutable typesModelEpoch = 0L
    let mutable localisationModelEpoch = 0L

    // Cache for the read-only shader runtime model (cwtools.ai.shader.* commands).
    // Rebuilt at most once per model epoch / open shader-script document version change.
    let shaderRuntimeModelCacheLock = obj ()
    let mutable shaderRuntimeModelCache: (ValidationModelEpoch * string * CWTools.Games.PdxShaderRuntime.ShaderRuntimeModel) option = None

    let modelEpochSnapshot () =
        { game = System.Threading.Interlocked.Read(&gameModelEpoch)
          rules = System.Threading.Interlocked.Read(&rulesModelEpoch)
          types = System.Threading.Interlocked.Read(&typesModelEpoch)
          localisation = System.Threading.Interlocked.Read(&localisationModelEpoch) }

    let bumpGameModelEpoch () = System.Threading.Interlocked.Increment(&gameModelEpoch) |> ignore
    let bumpRulesModelEpoch () = System.Threading.Interlocked.Increment(&rulesModelEpoch) |> ignore
    let bumpTypesModelEpoch () = System.Threading.Interlocked.Increment(&typesModelEpoch) |> ignore
    let bumpLocalisationModelEpoch () =
        System.Threading.Interlocked.Increment(&localisationModelEpoch) |> ignore

    let sameModelEpoch a b =
        a.game = b.game
        && a.rules = b.rules
        && a.types = b.types
        && a.localisation = b.localisation

    let sameIndexModelEpoch a b =
        a.game = b.game
        && a.rules = b.rules
        && a.types = b.types
    /// Per-file diagnostic metadata (freshness/epoch/counts), maintained by lint and delayedAnalyze
    let fileDiagnosticStates =
        System.Collections.Concurrent.ConcurrentDictionary<string, FileDiagnosticState>()

    let diagnosticStateMutationLock = obj ()
    let mutable diagnosticFreshFiles = 0L
    let mutable diagnosticPendingFiles = 0L
    let mutable diagnosticStaleFiles = 0L
    let mutable diagnosticErrors = 0L
    let mutable diagnosticWarnings = 0L

    let applyDiagnosticCounterDelta sign (state: FileDiagnosticState) =
        let delta = int64 sign
        match state.freshness with
        | Fresh -> System.Threading.Interlocked.Add(&diagnosticFreshFiles, delta) |> ignore
        | Pending -> System.Threading.Interlocked.Add(&diagnosticPendingFiles, delta) |> ignore
        | Stale -> System.Threading.Interlocked.Add(&diagnosticStaleFiles, delta) |> ignore
        System.Threading.Interlocked.Add(&diagnosticErrors, delta * int64 state.errorCount) |> ignore
        System.Threading.Interlocked.Add(&diagnosticWarnings, delta * int64 state.warningCount) |> ignore

    let updateFileDiagnosticState filePath state =
        lock diagnosticStateMutationLock (fun () ->
            match fileDiagnosticStates.TryGetValue filePath with
            | true, previous -> applyDiagnosticCounterDelta -1 previous
            | _ -> ()
            fileDiagnosticStates.[filePath] <- state
            applyDiagnosticCounterDelta 1 state)

    let removeFileDiagnosticState (filePath: string) =
        lock diagnosticStateMutationLock (fun () ->
            let mutable previous = Unchecked.defaultof<FileDiagnosticState>
            if fileDiagnosticStates.TryRemove(filePath, &previous) then
                applyDiagnosticCounterDelta -1 previous
                true
            else
                false)

    let clearFileDiagnosticStates () =
        lock diagnosticStateMutationLock (fun () ->
            fileDiagnosticStates.Clear()
            System.Threading.Interlocked.Exchange(&diagnosticFreshFiles, 0L) |> ignore
            System.Threading.Interlocked.Exchange(&diagnosticPendingFiles, 0L) |> ignore
            System.Threading.Interlocked.Exchange(&diagnosticStaleFiles, 0L) |> ignore
            System.Threading.Interlocked.Exchange(&diagnosticErrors, 0L) |> ignore
            System.Threading.Interlocked.Exchange(&diagnosticWarnings, 0L) |> ignore)

    let mutable dynamicPreflightTimeoutMs = 2000
    let mutable dynamicPreflightMaxEntities = 2000
    let mutable deferDynamicParameterDiagnostics = true
    let mutable dynamicDeferDelayMs = 300
    let dynamicDeferMaxFiles = 500
    // Dynamic call-site validation and staged global refreshes both construct
    // large rule graphs. Serialize them so a local edit cannot retain both
    // snapshots at once and multiply peak memory.
    let heavyAnalysisGate = new System.Threading.SemaphoreSlim(1, 1)
    let acquireHeavyAnalysisGate () =
        heavyAnalysisGate.Wait()
        { new IDisposable with
            member _.Dispose() = heavyAnalysisGate.Release() |> ignore }

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
          lastRulesSource = "not_started"
          lastCacheStatus = "not_started"
          lastPrecacheFileCount = 0
          lastError = None }

    let completionRuntimeLock = obj()
    let mutable completionRuntimeState =
        { totalRequests = 0
          cacheHits = 0
          cacheMisses = 0
          lockTimeoutFallbacks = 0
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

    /// Validation yields to completion: while a completion was requested within this grace
    /// window, the debounced lint and full RefreshCaches defer so they never grab the write
    /// lock mid-completion. Bounded by maxDebounceDefer / maxRefreshSkipCount to avoid starvation.
    let completionGraceMs = 700L
    let maxDebounceDefer = 4
    let completionHeavySemanticDeferMs = 2500L
    let completionHeavyTypingDeferMs = 1000L
    let completionHeavySaveFallbackMs = 2500L
    let lintStartYieldDelayMs = 120
    let mutable lastCompletionHeavyEditAtUnixMs = 0L
    let mutable lastCompletionHeavyTextEditAtUnixMs = 0L
    let mutable lastCompletionHeavySaveAtUnixMs = 0L

    let isCompletionActive () =
        nowUnixMs () - (completionRuntimeSnapshot ()).lastStartedAtUnixMs < completionGraceMs

    let markCompletionHeavyEditActivity () =
        lastCompletionHeavyEditAtUnixMs <- nowUnixMs ()

    let markCompletionHeavySaveActivity () =
        let now = nowUnixMs ()
        lastCompletionHeavyEditAtUnixMs <- now
        lastCompletionHeavySaveAtUnixMs <- now

    let markCompletionHeavyTextEditActivity () =
        let now = nowUnixMs ()
        lastCompletionHeavyEditAtUnixMs <- now
        lastCompletionHeavyTextEditAtUnixMs <- now

    let isCompletionHeavyInteractiveWindow () =
        isCompletionActive ()
        || nowUnixMs () - lastCompletionHeavyEditAtUnixMs < completionHeavySemanticDeferMs

    let isCompletionHeavyTypingWindow () =
        nowUnixMs () - lastCompletionHeavyTextEditAtUnixMs < completionHeavyTypingDeferMs

    let isCompletionHeavySaveFallbackWindow () =
        nowUnixMs () - lastCompletionHeavySaveAtUnixMs < completionHeavySaveFallbackMs

    //-PerfCounters performance observation-
    //Lightweight indicator aggregation, periodically output to log, used for long session performance analysis
    let mutable perfLintCount = 0
    let mutable perfRefreshCachesCount = 0
    let mutable perfRefreshLocCount = 0
    let mutable perfCompletionCount = 0
    let mutable perfLastReportTime = DateTime.UtcNow
    let perfReportIntervalSeconds = 30.0
    let writeLockHoldBudgetMs = 100L
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

    do monitorLog Lifecycle $"ServerLifecycle stage=started {lifecycleIdentity} {getPerfMemorySnapshot()}"

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
        let freshFiles = System.Threading.Volatile.Read(&diagnosticFreshFiles)
        let pendingFiles = System.Threading.Volatile.Read(&diagnosticPendingFiles)
        let staleFiles = System.Threading.Volatile.Read(&diagnosticStaleFiles)
        let errors = System.Threading.Volatile.Read(&diagnosticErrors)
        let warnings = System.Threading.Volatile.Read(&diagnosticWarnings)
        $" diag[files={fileDiagnosticStates.Count} fresh={freshFiles} pending={pendingFiles} stale={staleFiles} errors={errors} warnings={warnings}]"

    let getDiagnosticSummaryJson () =
        let freshFiles = System.Threading.Volatile.Read(&diagnosticFreshFiles)
        let pendingFiles = System.Threading.Volatile.Read(&diagnosticPendingFiles)
        let staleFiles = System.Threading.Volatile.Read(&diagnosticStaleFiles)
        let errors = System.Threading.Volatile.Read(&diagnosticErrors)
        let warnings = System.Threading.Volatile.Read(&diagnosticWarnings)
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
               "lastRulesSource", JsonValue.String state.lastRulesSource
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

    let mutable defaultRemoteRepoPath: string option = None
    let mutable remoteRepoPath: string option = None
    let mutable bundledRulesPath: string option = None

    let mutable rulesChannel: string = "stable"
    let mutable manualRulesFolder: string option = None
    let mutable useManualRules: bool = false
    let mutable preferBundledRules: bool = false
    let mutable semanticCatalogCache: (SemanticRuleInfo list * SemanticDefinitionReferenceInfo list * SemanticDefinitionShaderReferenceInfo list * string * bool) option = None
    let mutable semanticCatalogGeneration = 0L
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
            let refs = game.References()
            let m =
                if languages.Length <= 1 then
                    refs.Localisation
                else
                    // Resolve duplicate keys by configured language priority (languages.[0] wins), not loc file-path order.
                    let map = System.Collections.Generic.Dictionary<string, Entry>()
                    for (k, e) in refs.Localisation do map.[k] <- e
                    for lang in Array.rev languages do
                        for (k, e) in refs.LocalisationForLang lang do map.[k] <- e
                    [ for kvp in map -> (kvp.Key, kvp.Value) ]
            cachedLocMap <- Some m
            cachedLocMapCount <- m.Length
            m

    /// SemanticTokens cache: filePath -> (documentVersion, contentHash, encodedDataArray, resultId)
    /// Avoids full AST re-traversal when file content hasn't changed.
    /// resultId enables delta diff against the previous snapshot.
    let semanticTokensCache = System.Collections.Concurrent.ConcurrentDictionary<string, int option * int * int[] * string>()
    let semanticClassificationCacheMaxEntries = 100_000
    let semanticClassificationCacheLock = obj()
    let mutable semanticClassificationCacheSource: obj = null
    let mutable semanticClassificationRulesEpoch = -1L
    let mutable semanticClassificationTypesEpoch = -1L
    let mutable semanticEffectNames =
        System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase)
    let mutable semanticTriggerNames =
        System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase)

    /// CodeLens cache: filePath -> (contentHash, lenses).
    let codeLensCache = System.Collections.Concurrent.ConcurrentDictionary<string, int * CodeLens list>()
    let typeReferenceResultCache = System.Collections.Concurrent.ConcurrentDictionary<string, range list>()

    /// InlayHint cache: filePath -> (contentHash, hints)
    let inlayHintCache = System.Collections.Concurrent.ConcurrentDictionary<string, int * InlayHint list>()

    /// Short-lived same-position completion list cache.
    let completionListTtlMs = 2500.0
    let completionListCacheMaxEntries = 128
    let completionListCache =
        System.Collections.Concurrent.ConcurrentDictionary<string, DateTime * CompletionList option>()

    /// Latest completion position that received a stale lock-timeout response per file.
    /// Once the writer releases the game-state lock, the client can safely retry if the
    /// user is still at that exact position.
    let pendingCompletionRefreshMaxEntries = 128
    let pendingCompletionRefresh =
        System.Collections.Concurrent.ConcurrentDictionary<string, CompletionParams * int>()

    let normaliseCachePath (filePath: string) =
        try FileInfo(filePath).FullName.Replace('\\', '/').ToLowerInvariant()
        with _ -> filePath.Replace('\\', '/').ToLowerInvariant()

    let clearSemanticClassificationCache () =
        lock semanticClassificationCacheLock (fun () ->
            semanticClassificationCacheSource <- null
            semanticClassificationRulesEpoch <- -1L
            semanticClassificationTypesEpoch <- -1L
            semanticEffectNames <-
                System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase)
            semanticTriggerNames <-
                System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase))

    let getSemanticClassificationNames
        (cancellationToken: System.Threading.CancellationToken)
        (game: IGame)
        =
        lock semanticClassificationCacheLock (fun () ->
            cancellationToken.ThrowIfCancellationRequested()
            if not (Object.ReferenceEquals(semanticClassificationCacheSource, game))
               || semanticClassificationRulesEpoch <> rulesModelEpoch
               || semanticClassificationTypesEpoch <> typesModelEpoch then
                let buildBoundedSet names =
                    let next =
                        System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase)
                    let mutable index = 0

                    for name in names |> Seq.truncate semanticClassificationCacheMaxEntries do
                        if index % 256 = 0 then cancellationToken.ThrowIfCancellationRequested()
                        next.Add(name) |> ignore
                        index <- index + 1

                    next

                semanticEffectNames <-
                    game.ScriptedEffects()
                    |> Seq.map (fun effect -> effect.Name.GetString())
                    |> buildBoundedSet
                semanticTriggerNames <-
                    game.ScriptedTriggers()
                    |> Seq.map (fun trigger -> trigger.Name.GetString())
                    |> buildBoundedSet
                semanticClassificationCacheSource <- game
                semanticClassificationRulesEpoch <- rulesModelEpoch
                semanticClassificationTypesEpoch <- typesModelEpoch

            semanticEffectNames, semanticTriggerNames)

    let completionFallbackKind (filePath: string) =
        let normalised = filePath.Replace('\\', '/').ToLowerInvariant()
        if normalised.Contains("common/scripted_effects/") then Some "scripted_effects"
        elif normalised.Contains("common/scripted_triggers/") then Some "scripted_triggers"
        elif normalised.Contains("common/script_values/") then Some "script_values"
        elif normalised.Contains("common/inline_scripts/") then Some "inline_scripts"
        elif normalised.Contains("/common/") || normalised.Contains("\\common\\") then Some "common"
        elif normalised.Contains("/events/") || normalised.Contains("\\events\\") then Some "events"
        else None

    let queueCompletionRefresh (p: CompletionParams) =
        let filePath = getPathFromDoc p.textDocument.uri
        let key = normaliseCachePath filePath
        if pendingCompletionRefresh.Count >= pendingCompletionRefreshMaxEntries
           && not (pendingCompletionRefresh.ContainsKey key) then
            pendingCompletionRefresh.Clear()
        let version = docs.GetVersion(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue -1
        pendingCompletionRefresh.[key] <- (p, version)

    let clearMatchingCompletionRefresh (p: CompletionParams) =
        let filePath = getPathFromDoc p.textDocument.uri
        let key = normaliseCachePath filePath
        match pendingCompletionRefresh.TryGetValue key with
        | true, (pending, _) when
            pending.position.line = p.position.line
            && pending.position.character = p.position.character ->
            pendingCompletionRefresh.TryRemove key |> ignore
        | _ -> ()

    let flushCompletionRefresh (key: string) =
        let mutable removed = Unchecked.defaultof<CompletionParams * int>
        if pendingCompletionRefresh.TryRemove(key, &removed) then
            let pending, version = removed
            client.CustomNotification(
                "completionRefresh",
                JsonValue.Record
                    [| "uri", JsonValue.String(pending.textDocument.uri.ToString())
                       "line", JsonValue.Number(decimal pending.position.line)
                       "character", JsonValue.Number(decimal pending.position.character)
                       "version", JsonValue.Number(decimal version) |]
            )

    let flushCompletionRefreshForFile filePath =
        flushCompletionRefresh (normaliseCachePath filePath)

    let flushAllCompletionRefreshes () =
        for key in pendingCompletionRefresh.Keys |> Seq.toArray do
            flushCompletionRefresh key

    let isCompletionFallbackHeavyPath filePath =
        completionFallbackKind filePath |> Option.isSome

    /// Deterministic content hash using FNV-1a instead of string.GetHashCode()
    /// because string.GetHashCode() is randomized per-process in .NET Core.
    let contentHash (text: string) =
        let mutable hash = 2166136261u
        for i = 0 to text.Length - 1 do
            hash <- (hash ^^^ (uint32 text.[i])) * 16777619u
        int hash

    let completionFallbackPrefix (fileText: string) (position: LSP.Types.Position) =
        CompletionText.prefixAtPosition fileText position.line position.character

    let tryBuildStaleCompletionFallback (p: CompletionParams) allowEmpty =
        let filePath = getPathFromDoc p.textDocument.uri
        let fileText = docs.GetText(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue ""
        let freshHit =
            let cacheKey =
                CompletionText.completionCacheKey
                    (normaliseCachePath filePath)
                    (contentHash fileText)
                    p.position.line
                    p.position.character
                    debugMode
                    clientSupportsInsertReplaceEdit
            match completionListCache.TryGetValue cacheKey with
            | true, (createdAt, Some cached)
                when (DateTime.UtcNow - createdAt).TotalMilliseconds <= completionListTtlMs ->
                Some(cached, completionFallbackPrefix fileText p.position)
            | _ -> None

        match freshHit with
        | Some(result, prefix) when allowEmpty || not result.items.IsEmpty ->
            Some(result, prefix)
        | _ ->
            if allowEmpty then
                Some({ isIncomplete = true; items = [] }, completionFallbackPrefix fileText p.position)
            else
                None

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

    /// Lazily cached type definitions for files that actually request CodeLens.
    /// Keeping this per-file avoids duplicating the complete project type map in large mods.
    let typeDefinitionsByFileCacheMaxEntries = 128
    let typeDefinitionsByFileCache =
        System.Collections.Concurrent.ConcurrentDictionary<string, (string * string * TypeDefInfo) list>()
    let normalisedTypeDefinitionPathCacheMaxEntries = 32_768
    let normalisedTypeDefinitionPathCache =
        System.Collections.Concurrent.ConcurrentDictionary<string, string>()

    let normaliseTypeDefinitionPath path =
        match normalisedTypeDefinitionPathCache.TryGetValue path with
        | true, cached -> cached
        | false, _ ->
            if normalisedTypeDefinitionPathCache.Count >= normalisedTypeDefinitionPathCacheMaxEntries then
                normalisedTypeDefinitionPathCache.Clear()
            let normalised = normaliseCachePath path
            normalisedTypeDefinitionPathCache.[path] <- normalised
            normalised

    let getTypesForFile (cancellationToken: System.Threading.CancellationToken) (game: IGame) filePath =
        cancellationToken.ThrowIfCancellationRequested()
        let key = normaliseCachePath filePath

        match typeDefinitionsByFileCache.TryGetValue key with
        | true, cached -> cached
        | false, _ ->
            let belongsToRequestedFile path =
                normaliseTypeDefinitionPath path = key

            let result =
                game.Types()
                |> Map.toSeq
                |> Seq.collect (fun (typeName, definitions) ->
                    cancellationToken.ThrowIfCancellationRequested()
                    if typeName.Contains(".") then
                        Seq.empty
                    else
                        definitions
                        |> Seq.choose (fun definition ->
                            cancellationToken.ThrowIfCancellationRequested()
                            if belongsToRequestedFile definition.range.FileName then
                                Some(typeName, definition.id, definition)
                            else
                                None))
                |> Seq.toList

            if typeDefinitionsByFileCache.Count >= typeDefinitionsByFileCacheMaxEntries
               && not (typeDefinitionsByFileCache.ContainsKey key) then
                typeDefinitionsByFileCache.Clear()

            typeDefinitionsByFileCache.[key] <- result
            result

    let clearTypeIndexCache () =
        typeDefinitionsByFileCache.Clear()

    let clearTypeIndexCacheForFile (filePath: string) =
        let normalised = normaliseCachePath filePath
        typeDefinitionsByFileCache.TryRemove(normalised) |> ignore
        let fullPath = try FileInfo(filePath).FullName with _ -> filePath
        typeDefinitionsByFileCache.TryRemove(normaliseCachePath fullPath) |> ignore

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

    let clearFileCachesPreservingSemanticTokens (filePath: string) =
        let fullPath = try FileInfo(filePath).FullName with _ -> filePath
        for key in [ filePath; fullPath ] do
            (codeLensCache :> System.Collections.Generic.IDictionary<_, _>).Remove(key) |> ignore
            (inlayHintCache :> System.Collections.Generic.IDictionary<_, _>).Remove(key) |> ignore
            clearCompletionListCacheForFile key
        typeReferenceResultCache.Clear()

    /// Clear the type index related cache (called after the type-defining file changes)
    let clearTypeCaches () =
        clearTypeIndexCache ()
        clearSemanticClassificationCache ()
        completionListCache.Clear()
        codeLensCache.Clear()  // CodeLens depends on type index
        typeReferenceResultCache.Clear()

    /// Invalidate the derived localisation-entry map after a .yml change. Keep
    /// published per-file diagnostics until the incremental pass has complete
    /// replacements, so an edit never creates a transient false-negative set.
    let clearLocalisationCaches () =
        cachedLocMap <- None
        cachedLocMapCount <- 0

    /// Clear all derived caches (called after full refresh)
    let clearAllDerivedCaches () =
        codeLensCache.Clear()
        inlayHintCache.Clear()
        clearTypeIndexCache ()
        clearSemanticClassificationCache ()
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
                let groupedTypeFiles = typeDefinitionsByFileCache.Count
                $" caches[semantic={semanticTokensCache.Count} codeLens={codeLensCache.Count} inlay={inlayHintCache.Count} locFiles={locCache.Count} locKeys={cachedLocMapCount} completionTTL={completionListCache.Count} typeRefs={typeReferenceResultCache.Count} groupedTypeFiles={groupedTypeFiles} cacheWriteKeys={cacheWriteTimes.Count} resourceEpoch={ResourceManagerEager.currentResource ()} carrierEpoch={ResourceManagerEager.currentCarrier ()} typeRulesEpoch={ResourceManagerEager.currentTypeRules ()} localisationEpoch={ResourceManagerEager.currentLocalisation ()} fileSetEpoch={ResourceManagerEager.currentFileSet ()}]"

    let getCacheSnapshotJson () =
        let groupedTypeFiles = typeDefinitionsByFileCache.Count
        JsonValue.Record
            [| "semanticTokens", JsonValue.Number(decimal semanticTokensCache.Count)
               "codeLens", JsonValue.Number(decimal codeLensCache.Count)
               "inlayHints", JsonValue.Number(decimal inlayHintCache.Count)
               "locFiles", JsonValue.Number(decimal locCache.Count)
               "locKeys", JsonValue.Number(decimal cachedLocMapCount)
               "completionTtl", JsonValue.Number(decimal completionListCache.Count)
               "typeReferences", JsonValue.Number(decimal typeReferenceResultCache.Count)
               "groupedTypeFiles", JsonValue.Number(decimal groupedTypeFiles)
               "cacheWriteKeys", JsonValue.Number(decimal cacheWriteTimes.Count)
               "resourceEpoch", JsonValue.Number(decimal (ResourceManagerEager.currentResource ()))
               "carrierEpoch", JsonValue.Number(decimal (ResourceManagerEager.currentCarrier ()))
               "typeRulesEpoch", JsonValue.Number(decimal (ResourceManagerEager.currentTypeRules ()))
               "localisationEpoch", JsonValue.Number(decimal (ResourceManagerEager.currentLocalisation ()))
               "fileSetEpoch", JsonValue.Number(decimal (ResourceManagerEager.currentFileSet ())) |]

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
               "lockTimeoutFallbacks", JsonValue.Number(decimal state.lockTimeoutFallbacks)
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

    do
        LSP.LanguageServer.completionImmediateFallback <-
            Some(fun (p: CompletionParams) ->
                let filePath = getPathFromDoc p.textDocument.uri
                let validationInProgress = (validationRuntimeSnapshot ()).inProgress
                let writerBusy = isGameStateWriteBusy ()
                let heavyPathWindow =
                    isCompletionFallbackHeavyPath filePath
                    && isCompletionHeavySaveFallbackWindow ()
                    && (isCompletionHeavyTypingWindow () || isCompletionActive ())
                let shouldFallback =
                    Main.CompletionFallbackPolicy.shouldUseImmediateFallback
                        writerBusy
                        validationInProgress
                        heavyPathWindow
                if shouldFallback then
                    let fallback =
                        tryBuildStaleCompletionFallback p false
                        |> Option.orElseWith (fun () ->
                            if
                                Main.CompletionFallbackPolicy.canReturnEmptyFallback
                                    writerBusy
                                    validationInProgress
                            then
                                Some({ isIncomplete = true; items = [] }, None)
                            else
                                None)
                    match fallback with
                    | Some(result, prefix) ->
                        queueCompletionRefresh p
                        let prefixText = prefix |> Option.defaultValue ""
                        monitorLog Completion
                            $"Completion immediate fallback file={filePath} line={p.position.line} char={p.position.character} prefix={prefixText} staleItems={result.items.Length} writerBusy={writerBusy} validationInProgress={validationInProgress}"
                        Some result
                    | None -> None
                else
                    None)

        LSP.LanguageServer.completionTimeoutFallback <-
            Some(fun (p: CompletionParams) ->
                let filePath = getPathFromDoc p.textDocument.uri
                queueCompletionRefresh p
                updateCompletionRuntime (fun state ->
                    { state with
                        totalRequests = state.totalRequests + 1
                        lockTimeoutFallbacks = state.lockTimeoutFallbacks + 1
                        lastCompletedAtUnixMs = nowUnixMs ()
                        lastFile = filePath
                        lastLine = p.position.line
                        lastCharacter = p.position.character })
                let result, prefix =
                    tryBuildStaleCompletionFallback p true
                    |> Option.defaultValue ({ isIncomplete = true; items = [] }, None)
                let prefixText = prefix |> Option.defaultValue ""
                monitorLog Completion
                    $"Completion lock-timeout fallback file={filePath} line={p.position.line} char={p.position.character} prefix={prefixText} staleItems={result.items.Length}"
                Some result)

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

    let clearLocalisationDiagnosticCache () =
        for key in locCache.Keys do
            clearCacheWriteTimesForFile key
        locCache.Clear()

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
        let uri = filePathToUri(filePath).ToString()

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
        let tokenWidth = 5
        let tokenEquals oldIndex newIndex =
            oldIndex + tokenWidth <= oldTokens.Length
            && newIndex + tokenWidth <= newTokens.Length
            && oldTokens.[oldIndex .. oldIndex + tokenWidth - 1] = newTokens.[newIndex .. newIndex + tokenWidth - 1]

        let mutable startIndex = 0
        while tokenEquals startIndex startIndex do
            startIndex <- startIndex + tokenWidth

        let mutable oldEnd = oldTokens.Length - tokenWidth
        let mutable newEnd = newTokens.Length - tokenWidth
        while oldEnd >= startIndex
              && newEnd >= startIndex
              && tokenEquals oldEnd newEnd do
            oldEnd <- oldEnd - tokenWidth
            newEnd <- newEnd - tokenWidth

        let deleteCount = max 0 (oldEnd - startIndex + tokenWidth)
        let inserted =
            if newEnd < startIndex then [||]
            else newTokens.[startIndex .. newEnd + tokenWidth - 1]
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

    let mutable lastFocusedFile: string option = None

    /// Atomic flag 0 = idle, 1 = refreshing. File-list refreshes are structural
    /// work and run only after create/delete notifications, never on every open.
    let currentlyRefreshingFiles = ref 0
    let fileListRefreshPending = ref 0

    let rec queueFileListRefresh (game: IGame) =
        System.Threading.Interlocked.Exchange(fileListRefreshPending, 1) |> ignore

        if System.Threading.Interlocked.CompareExchange(currentlyRefreshingFiles, 1, 0) = 0 then
            let mapResourceToFilePath =
                function
                | EntityResource(f, r) -> r.scope, f, r.logicalpath
                | FileResource(f, r) -> r.scope, f, r.logicalpath
                | FileWithContentResource(f, r) -> r.scope, f, r.logicalpath

            let task =
                new Task(fun () ->
                    try
                        let mutable refreshAgain = true

                        while refreshAgain do
                            System.Threading.Interlocked.Exchange(fileListRefreshPending, 0) |> ignore
                            gameStateLock.EnterReadLock()

                            let fileList =
                                try
                                    game.AllFiles()
                                    |> List.map mapResourceToFilePath
                                    |> List.map (fun (scope, file, logicalPath) ->
                                        let uri = filePathToUri file
                                        JsonValue.Record
                                            [| "scope", JsonValue.String scope
                                               "uri", JsonValue.String uri.AbsoluteUri
                                               "logicalpath", JsonValue.String logicalPath |])
                                    |> Array.ofList
                                finally
                                    gameStateLock.ExitReadLock()

                            client.CustomNotification(
                                "updateFileList",
                                JsonValue.Record [| "fileList", JsonValue.Array fileList |]
                            )

                            refreshAgain <-
                                System.Threading.Interlocked.CompareExchange(fileListRefreshPending, 0, 0) <> 0
                    finally
                        System.Threading.Interlocked.Exchange(currentlyRefreshingFiles, 0) |> ignore

                        if System.Threading.Interlocked.Exchange(fileListRefreshPending, 0) <> 0 then
                            queueFileListRefresh game)

            task.Start()

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

    let isDynamicParameterError (code: string) (message: string) (related: CWRelatedError list option) =
        code = "CW274"
        || message.Contains("results in an error")
        || (match related with
            | Some rs -> rs |> List.exists (fun (r: CWRelatedError) -> r.message = "Related source")
            | None -> false)

    let uncertainGlobalNegativeCodes =
        set
            [ "CW100"; "CW101"; "CW102"; "CW103"; "CW111"; "CW112"
              "CW113"; "CW114"; "CW117"; "CW118"; "CW222"; "CW225"
              "CW226"; "CW227"; "CW228"; "CW229"; "CW232"; "CW233"
              "CW239"; "CW246"; "CW250"; "CW261"; "CW266"; "CW273"
              "CW274"; "CW274D" ]

    let localisationDiagnosticCodes =
        set
            [ "CW100"; "CW225"; "CW226"; "CW234"; "CW254"; "CW255"
              "CW256"; "CW257"; "CW258"; "CW259"; "CW260"; "CW266"
              "CW268"; "CW275" ]

    let isLocalisationDiagnostic (diagnostic: Diagnostic) =
        diagnostic.code
        |> Option.exists localisationDiagnosticCodes.Contains

    /// Diagnostics whose truth depends on a complete global lookup/index. While
    /// editing a type-defining file these are deferred until the staged index is
    /// committed or a save/deep validation runs. Local parser/shape/CWT errors
    /// continue to be published immediately.
    let isUncertainGlobalNegativeError (error: CWError) =

        let message = error.message
        let referenceShapedMessage =
            message.Contains("not found", StringComparison.OrdinalIgnoreCase)
            || message.Contains("does not exist", StringComparison.OrdinalIgnoreCase)
            || message.Contains("not defined", StringComparison.OrdinalIgnoreCase)
            || message.Contains("never defined", StringComparison.OrdinalIgnoreCase)
            || message.Contains("unknown", StringComparison.OrdinalIgnoreCase)
            || message.Contains("Expected value of type", StringComparison.OrdinalIgnoreCase)

        uncertainGlobalNegativeCodes.Contains(error.code)
        || (error.code = "CW240" && referenceShapedMessage)
        || isDynamicParameterError error.code error.message error.relatedErrors

    /// Documentation page for CW error codes; anchors are the lowercase code (e.g. #cw102).
    let diagnosticDocsUrl =
        "https://github.com/Aa728848/cwtools-vscode/blob/main/docs/diagnostic-codes.md"

    let diagnosticTags (code: string) (message: string) =
        if code = "CW236" || code = "CW253" then
            Some [ DiagnosticTagDeprecated ]
        elif code = "CW224" || code = "CW251" || message = "This error is retired" then
            Some [ DiagnosticTagUnnecessary ]
        else
            None

    let diagnosticCodeDescription (code: string) =
        if code.StartsWith("CW", StringComparison.OrdinalIgnoreCase) then
            // CW001_MISSING_CLOSE_BRACE etc. share the CW001 docs section
            let shortCode = code.Split('_').[0].ToLowerInvariant()
            Some { CodeDescription.href = diagnosticDocsUrl + "#" + shortCode }
        else
            None

    let parserErrorToDiagnostics e =
        let code, sev, file, error, (position: range), length, related = e

        let startC, endC =
            match length with
            | 0 ->
                // No key length available: highlight the reported range itself,
                // never the whole line prefix before it.
                let s = int position.StartColumn
                let endCol = int position.EndColumn
                if endCol > s then s, endCol else s, s + 1
            | _ -> (int position.StartColumn), (int position.StartColumn) + length

        let startLine = (int position.StartLine) - 1
        let startLine = max startLine 0

        let result =
            { range =
                { start = { line = startLine; character = startC }
                  ``end`` = { line = startLine; character = endC } }
              severity = Some(sevToDiagSev sev)
              code = Some code
              codeDescription = diagnosticCodeDescription code
              source = Some "CWTools"
              message = error
              tags = diagnosticTags code error
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

    let setFileDiagnosticStateWithSnapshot
        filePath
        epoch
        validatedVersion
        modelEpoch
        freshness
        pendingKinds
        diagnostics
        =
        let errCount, warnCount = diagnosticCounts diagnostics
        let state =
            { version = validatedVersion
              validatedVersion = validatedVersion
              epoch = epoch
              updatedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
              freshness = freshness
              pendingGlobalKinds = pendingKinds
              modelEpoch = modelEpoch
              errorCount = errCount
              diagnostics = diagnostics
              warningCount = warnCount }
        updateFileDiagnosticState filePath state

    let setFileDiagnosticStateWithEpoch filePath epoch freshness pendingKinds diagnostics =
        setFileDiagnosticStateWithSnapshot
            filePath
            epoch
            (docs.GetVersionByPath(filePath))
            (modelEpochSnapshot ())
            freshness
            pendingKinds
            diagnostics

    let nextDiagnosticEpoch () =
        System.Threading.Interlocked.Increment(diagnosticEpoch)

    let setFileDiagnosticState filePath freshness pendingKinds diagnostics =
        setFileDiagnosticStateWithEpoch filePath (nextDiagnosticEpoch ()) freshness pendingKinds diagnostics

    let diagnosticsForFile filePath diagnostics =
        let normalisedPath = normaliseCachePath filePath
        diagnostics
        |> List.choose (fun (f, d) ->
            if normaliseCachePath f = normalisedPath then Some d else None)

    let existingDiagnosticsForFile filePath =
        match fileDiagnosticStates.TryGetValue(filePath) with
        | true, state -> state.diagnostics
        | false, _ ->
            let normalisedPath = normaliseCachePath filePath
            fileDiagnosticStates
            |> Seq.tryPick (fun kvp ->
                if normaliseCachePath kvp.Key = normalisedPath then
                    Some kvp.Value.diagnostics
                else
                    None)
            |> Option.defaultValue []

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

    let mutable delayedScriptLocUpdate = false
    let pendingScriptLocalisationFiles = System.Collections.Concurrent.ConcurrentDictionary<string, byte>()
    let mutable lastScriptLocUpdateAt = DateTime.MinValue
    /// Floor between idle script loc recomputes.
    let scriptLocUpdateCooldown = TimeSpan.FromSeconds(3.0)

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

    let incrementalTypeRefreshEnabled () =
        match gameObj with
        | Some (:? IIncrementalTypeIndex) -> true
        | _ -> false

    let isCurrentGameLocalisationFile path =
        match gameObj with
        | Some (:? IIncrementalLocalisation as incremental) ->
            incremental.IsLocalisationFile path
        | _ ->
            path.EndsWith(".yml", StringComparison.OrdinalIgnoreCase)

    let isIncrementalContributionCandidate path =
        not (isCurrentGameLocalisationFile path)
        && not (PdxShaderFeatures.isShaderFile path)
    let maxIncrementalScriptedPatchCount = 25
    let mutable incrementalScriptedPatchCount = 0

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

    let markFilePendingGlobalRevalidation filePath =
        // publishDiagnostics replaces a URI's whole list. Keep the client list
        // untouched until this file has a complete replacement result.
        let retainedDiagnostics =
            existingDiagnosticsForFile filePath
            |> DiagnosticMerge.preserveWhilePending
        let pendingKinds =
            let existingPendingKinds =
                match fileDiagnosticStates.TryGetValue(filePath) with
                | true, state -> state.pendingGlobalKinds
                | false, _ -> []
            existingPendingKinds @ refreshDomainsForPath filePath @ [ "types"; "rules" ]
            |> List.distinct
        let version = docs.GetVersionByPath(filePath)
        setFileDiagnosticStateWithSnapshot
            filePath
            (nextDiagnosticEpoch ())
            version
            (modelEpochSnapshot ())
            Pending
            pendingKinds
            retainedDiagnostics

    let markFilePendingDynamicRevalidation filePath =
        let priorState =
            match fileDiagnosticStates.TryGetValue(filePath) with
            | true, state -> Some state
            | false, _ -> None
        let retainedDiagnostics =
            priorState
            |> Option.map _.diagnostics
            |> Option.defaultWith (fun () -> existingDiagnosticsForFile filePath)
            |> DiagnosticMerge.preserveWhilePending
        let pendingKinds =
            (priorState |> Option.map _.pendingGlobalKinds |> Option.defaultValue [])
            @ [ "dynamicParameters" ]
            |> List.distinct
        let validatedVersion =
            priorState
            |> Option.bind _.validatedVersion
            |> Option.orElseWith (fun () -> docs.GetVersionByPath(filePath))
        setFileDiagnosticStateWithSnapshot
            filePath
            (nextDiagnosticEpoch ())
            validatedVersion
            (modelEpochSnapshot ())
            Pending
            pendingKinds
            retainedDiagnostics

    let typeDefinitionsForFiles (game: IGame) (files: string list) =
        let targetFiles = files |> List.map normaliseCachePath |> Set.ofList

        game.Types()
        |> Map.toList
        |> List.collect (fun (typeName, infos) ->
            infos
            |> Array.choose (fun info ->
                if targetFiles.Contains(normaliseCachePath info.range.FileName) then
                    Some(typeName, info.id)
                else
                    None)
            |> Array.toList)
        |> List.distinct

    /// Top-level assignment keys of a PDX file, lowercased and sorted. In the scripted
    /// dirs these are exactly the definition names, so comparing this signature against
    /// the type index detects whether an edit actually changed the definition set —
    /// body-only edits can then skip the incremental type refresh entirely.
    let topLevelDefinitionKeySignature (text: string) =
        let keys = ResizeArray<string>()
        let mutable depth = 0
        let mutable i = 0
        let n = text.Length

        while i < n do
            let c = text.[i]

            if c = '#' then
                while i < n && text.[i] <> '\n' do
                    i <- i + 1
            elif c = '"' then
                i <- i + 1
                while i < n && text.[i] <> '"' && text.[i] <> '\n' do
                    i <- i + 1
                i <- i + 1
            elif c = '{' then
                depth <- depth + 1
                i <- i + 1
            elif c = '}' then
                depth <- max 0 (depth - 1)
                i <- i + 1
            elif depth = 0 && (Char.IsLetter c || c = '_') then
                let start = i

                while i < n
                      && (Char.IsLetterOrDigit text.[i]
                          || text.[i] = '_'
                          || text.[i] = '.'
                          || text.[i] = ':') do
                    i <- i + 1

                let token = text.Substring(start, i - start)
                let mutable j = i

                while j < n && (text.[j] = ' ' || text.[j] = '\t') do
                    j <- j + 1

                if j < n && text.[j] = '=' then
                    keys.Add(token.ToLowerInvariant())
            else
                i <- i + 1

        keys |> Seq.sort |> List.ofSeq

    let scriptedDefinitionsForFiles (game: IGame) (files: string list) =
        typeDefinitionsForFiles game files
        |> List.filter (fun (typeName, _) -> scriptedTypeKeys |> List.contains typeName)
        |> List.distinct

    let referenceFilesForDefinitions (game: IGame) (definitions: (string * string) list) =
        definitions
        |> List.collect (fun (typeName, id) ->
            try
                game.FindAllRefsByType typeName id |> List.map _.FileName
            with e ->
                logDiag $"FindAllRefsByType failed for %s{typeName}:%s{id}: %s{e.Message}"
                [])
        |> List.distinctBy normaliseCachePath

    let referenceFilesForDefinitionsFromIndex (game: IGame) (definitions: (string * string) list) =
        try
            let index = game.TypeReferenceIndex()
            definitions
            |> List.collect (fun (typeName, id) ->
                let baseTypeName = typeName.Split('.').[0]
                let trimmedId = if isNull id then "" else id.Trim().Trim('"')
                index |> Map.tryFind (baseTypeName, trimmedId) |> Option.defaultValue []
                |> List.map _.FileName)
            |> List.distinctBy normaliseCachePath
        with e ->
            logDiag $"TypeReferenceIndex lookup failed: {e.Message}"
            []

    let referenceFilesForChangedDefinitions (game: IGame) (path: string) (definitions: (string * string) list) =
        if isEventDefinitionPath path then
            referenceFilesForDefinitionsFromIndex game definitions
        elif isDynamicDefinitionPath path then
            referenceFilesForDefinitions game definitions
        else
            []

    let mutable scheduleDeferredDynamicRevalidationImpl: string list -> unit = fun _ -> ()

    let scheduleDeferredDynamicRevalidation files =
        scheduleDeferredDynamicRevalidationImpl files

    let markDeferredRevalidationStale files =
        let queued =
            files
            |> List.distinctBy normaliseCachePath
            |> List.truncate dynamicDeferMaxFiles
        if files.Length > dynamicDeferMaxFiles then
            logDiag $"Deferred stale mark capped files={files.Length} cap={dynamicDeferMaxFiles}"
        for path in queued do
            clearFileCaches path
            markFilePendingGlobalRevalidation path

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
    let lint (doc: Uri) (shallowAnalyze: bool) (forceDisk: bool) (isEditAction: bool) (validateCachedOnly: bool) (fastDefinitionIndex: bool) (requestStillCurrent: unit -> bool) : Async<bool> =
        async {
            let name = getPathFromDoc doc

            if isEditAction then
                forgetFileCaches name

            if isCurrentGameLocalisationFile name then
                if isEditAction && not shallowAnalyze then
                    delayedLocUpdate <- true
                    addPendingRefreshDomains [ "localisation" ]
                    clearLocalisationCaches ()
                if isEditAction then markFileStale name "localisation"

            let usePreparedEditorUpdate = isEditAction
            let useInteractiveValidation =
                isEditAction
                && (shallowAnalyze
                    || isCurrentGameLocalisationFile name)

            let canTryIncrementalTypeRefresh =
                isEditAction
                && (not shallowAnalyze
                    || fastDefinitionIndex
                    || (useInteractiveValidation && isScriptedDefinitionPath name))
                && incrementalTypeRefreshEnabled ()
                && isIncrementalContributionCandidate name
                && not (isInlineScriptDefinitionPath name)

            if isEditAction
               && isIncrementalContributionCandidate name
               && not shallowAnalyze
               && not canTryIncrementalTypeRefresh
               && not (isInlineScriptDefinitionPath name) then
                needsTypeRefresh <- true
                lastTypeRefreshRequestAt <- DateTime.UtcNow
                let domains =
                    refreshDomainsForPath name @ [ "types"; "rules" ]
                    |> List.filter (fun domain -> domain <> "localisation")
                    |> List.distinct
                addPendingRefreshDomains domains
                clearTypeCaches ()
                markFileStale name "types"
            elif isEditAction
                 && shallowAnalyze
                 && not (isCurrentGameLocalisationFile name)
                 && isIncrementalContributionCandidate name
                 && not canTryIncrementalTypeRefresh then
                delayedScriptLocUpdate <- true
                pendingScriptLocalisationFiles.[name] <- 0uy

            // Capture text and document version atomically. Diagnostic publication
            // later verifies this exact version is still current.
            let documentSnapshot =
                if forceDisk then None
                else
                    docs.Get(FileInfo(doc.LocalPath))

            let filetext, validatedDocumentVersion =
                match documentSnapshot with
                | Some(text, version) -> Some text, Some version
                | None when forceDisk -> None, None
                | None ->
                    match (try Some(File.ReadAllText doc.LocalPath) with _ -> None) with
                    | Some text -> Some text, None
                    | None -> None, None

            let documentVersionStillCurrent () =
                match validatedDocumentVersion with
                | Some version -> docs.GetVersionByPath(name) = Some version
                | None -> true

            let lintSnapshotStillCurrent () =
                requestStillCurrent () && documentVersionStillCurrent ()

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
                    | x, _ when isCurrentGameLocalisationFile x -> []
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
            
            let mutable lintDeferredGlobalKinds: string list = []
            let mutable lintUpdateSuperseded = false
            let mutable preparedCommitRetryRequested = false
            let mutable validationModelEpochAtComputation: ValidationModelEpoch option = None
            let applicableCachedLocErrors = if isEditAction then [] else locErrors

            let errors =
                match gameObj with
                | None -> parserErrors @ applicableCachedLocErrors
                | Some game when validateCachedOnly ->
                    let allocBeforeValidate = GC.GetTotalAllocatedBytes(false)
                    let updateErrors =
                        if isCurrentGameLocalisationFile name then
                            // Localisation diagnostics are already partitioned in
                            // locCache. Calling ValidateFile here cannot contribute
                            // results, but used to force needless resource work on
                            // every open/focus of a localisation document.
                            validationModelEpochAtComputation <- Some(modelEpochSnapshot ())
                            []
                        else
                            gameStateLock.EnterReadLock()
                            try
                                let result =
                                    match game with
                                    | :? ICancellableFileValidation as cancellable ->
                                        cancellable.ValidateFileCancellable(shallowAnalyze, name, (fun () -> not (lintSnapshotStillCurrent ())))
                                    | _ when lintSnapshotStillCurrent () ->
                                        Some(game.ValidateFile shallowAnalyze name)
                                    | _ -> None

                                match result with
                                | Some completed ->
                                    validationModelEpochAtComputation <- Some(modelEpochSnapshot ())
                                    completed
                                | None ->
                                    lintUpdateSuperseded <- true
                                    []
                            finally gameStateLock.ExitReadLock()
                    let astErrors =
                        updateErrors
                        |> List.map (fun e ->
                            (e.code, e.severity, e.range.FileName, e.message, e.range, e.keyLength, e.relatedErrors))
                    let allocAfterValidate = GC.GetTotalAllocatedBytes(false)
                    monitorLog Lint $"ValidateFile file={name} shallow={shallowAnalyze} allocDeltaMB={(allocAfterValidate - allocBeforeValidate) / 1048576L}{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"
                    if isCurrentGameLocalisationFile name then parserErrors @ applicableCachedLocErrors
                    else parserErrors @ applicableCachedLocErrors @ astErrors
                | Some game ->
                    let allocBeforeUpdate = GC.GetTotalAllocatedBytes(false)

                    let interactiveResourceAlreadyCurrent =
                        fastDefinitionIndex
                        && (match validatedDocumentVersion, committedInteractiveVersions.TryGetValue(normaliseCachePath name) with
                            | Some version, (true, struct (committedVersion, committedGame)) ->
                                version = committedVersion
                                && Object.ReferenceEquals(game, committedGame)
                            | _ -> false)

                    // In the incremental scripted pipeline the deep validation pass runs
                    // post-commit under the READ lock, so the write-locked first pass only
                    // needs the shallow update — this keeps save-time write locks short.
                    let deferDeepValidation =
                        canTryIncrementalTypeRefresh && not fastDefinitionIndex && not useInteractiveValidation

                    let stagedEditorUpdate =
                        if usePreparedEditorUpdate
                           && not interactiveResourceAlreadyCurrent
                           && lintSnapshotStillCurrent () then
                            let prepareSw = Stopwatch.StartNew()
                            try
                                let staged = game.PrepareUpdateFileInteractive name filetext
                                prepareSw.Stop()
                                monitorLog Lint
                                    $"PrepareUpdateFileInteractive file={name} elapsed={prepareSw.ElapsedMilliseconds}ms"
                                Some staged
                            with e ->
                                logDiag $"PrepareUpdateFileInteractive failed for {name}: {e.Message}"
                                None
                        else
                            None

                    // A stable definition identity lets dynamic files take the
                    // type-index-only path when their richer semantic signature is
                    // also unchanged. Exact-version saves can skip staging entirely.
                    let newDefinitionSignature =
                        if canTryIncrementalTypeRefresh then
                            filetext |> Option.map topLevelDefinitionKeySignature
                        else
                            None

                    let incrementalIndexAlreadyCurrent =
                        canTryIncrementalTypeRefresh
                        && (match validatedDocumentVersion, committedTypeIndexVersions.TryGetValue(normaliseCachePath name) with
                            | Some version, (true, struct (committedVersion, committedGame)) ->
                                version = committedVersion
                                && Object.ReferenceEquals(game, committedGame)
                            | _ -> false)

                    let priorDefsSnapshot, priorIndexEpoch, priorSemanticSignature =
                        if canTryIncrementalTypeRefresh && not incrementalIndexAlreadyCurrent then
                            gameStateLock.EnterReadLock()
                            try
                                let semanticSignature =
                                    match game with
                                    | :? ISemanticDeltaProvider as provider -> provider.SemanticSignatureForFile name
                                    | _ -> None
                                typeDefinitionsForFiles game [ name ], modelEpochSnapshot (), semanticSignature
                            finally
                                gameStateLock.ExitReadLock()
                        else
                            [], modelEpochSnapshot (), None

                    let updateWriteWaitSw = Stopwatch.StartNew()
                    enterGameStateWriteLock ()
                    updateWriteWaitSw.Stop()
                    let updateWriteHoldSw = Stopwatch.StartNew()
                    let mutable nonTypeSemanticChanged = false
                    let (updateErrors,
                         priorDefsForRevalidation,
                         definitionIdentityUnchanged,
                         gameRefAtUpdate,
                         preparedUpdateCommitted,
                         updateSuperseded) =
                        try
                            let gameStillCurrent =
                                match gameObj with
                                | Some current -> System.Object.ReferenceEquals(current, game)
                                | None -> false
                            let indexSnapshotStillCurrent =
                                not canTryIncrementalTypeRefresh
                                || sameIndexModelEpoch priorIndexEpoch (modelEpochSnapshot ())

                            if not gameStillCurrent
                               || not indexSnapshotStillCurrent
                               || not (lintSnapshotStillCurrent ()) then
                                [], [], true, game, false, true
                            else
                                let priorDefs = priorDefsSnapshot

                                let identityUnchanged =
                                    match newDefinitionSignature with
                                    | Some newSignature ->
                                        let priorSignature =
                                            priorDefs
                                            |> List.filter (fun (typeName, _) ->
                                                scriptedTypeKeys |> List.contains typeName)
                                            |> List.map (fun (_, id) -> id.ToLowerInvariant())
                                            |> List.sort

                                        newSignature = priorSignature
                                    | None -> false

                                let prior =
                                    if canTryIncrementalTypeRefresh then priorDefs else []

                                if interactiveResourceAlreadyCurrent then
                                    [], prior, identityUnchanged, game, false, false
                                elif usePreparedEditorUpdate then
                                    match stagedEditorUpdate with
                                    | Some staged when game.CommitUpdateFileInteractive staged ->
                                        if staged.kind = LocalisationFile then bumpLocalisationModelEpoch ()
                                        if isIncrementalContributionCandidate name then
                                            validatedDocumentVersion
                                            |> Option.iter (fun version ->
                                                committedInteractiveVersions.[normaliseCachePath name] <- struct (version, game))
                                        [], prior, identityUnchanged, game, true, false
                                    | _ when not useInteractiveValidation ->
                                        // A prepared commit failure must not run full validation inside the write lock;
                                        // that path is the source of the 40-second hard freeze. Supersede this snapshot
                                        // and let the next edit/save or the validateCachedOnly read-lock path update the model.
                                        committedInteractiveVersions.TryRemove(normaliseCachePath name) |> ignore
                                        lintUpdateSuperseded <- true
                                        preparedCommitRetryRequested <- lintSnapshotStillCurrent ()
                                        logDiag $"Prepared commit failed for {name}; suppressing write-lock full-validation fallback retry={preparedCommitRetryRequested}"
                                        [], prior, identityUnchanged, game, false, true
                                    | _ ->
                                        preparedCommitRetryRequested <- lintSnapshotStillCurrent ()
                                        [], prior, identityUnchanged, game, false, true
                                else
                                    committedInteractiveVersions.TryRemove(normaliseCachePath name) |> ignore
                                    let errs = game.UpdateFile (shallowAnalyze || deferDeepValidation) name filetext
                                    if isCurrentGameLocalisationFile name then
                                        bumpLocalisationModelEpoch ()
                                    validationModelEpochAtComputation <- Some(modelEpochSnapshot ())
                                    errs, prior, identityUnchanged, game, false, false
                        finally
                            updateWriteHoldSw.Stop()
                            exitGameStateWriteLock ()
                            if updateWriteHoldSw.ElapsedMilliseconds > writeLockHoldBudgetMs then
                                monitorLog Performance
                                    $"WriteLock hold budget exceeded file={name} phase=update hold={updateWriteHoldSw.ElapsedMilliseconds}ms"

                    // Compare non-TypeDef global contributions outside the write
                    // lock so completion/hover remain available during the fold.
                    if canTryIncrementalTypeRefresh
                       && not incrementalIndexAlreadyCurrent
                       && not updateSuperseded
                       && lintSnapshotStillCurrent () then
                        gameStateLock.EnterReadLock()
                        try
                            let currentSignature =
                                match game with
                                | :? ISemanticDeltaProvider as provider -> provider.SemanticSignatureForFile name
                                | _ -> None
                            nonTypeSemanticChanged <-
                                currentSignature <> priorSemanticSignature
                                || (isDynamicDefinitionPath name
                                    && (currentSignature.IsNone || priorSemanticSignature.IsNone))
                        finally
                            gameStateLock.ExitReadLock()

                    let skipIncrementalRefresh = incrementalIndexAlreadyCurrent

                    if usePreparedEditorUpdate then
                        monitorLog Lint
                            $"CommitUpdateFileInteractive file={name} wait={updateWriteWaitSw.ElapsedMilliseconds}ms hold={updateWriteHoldSw.ElapsedMilliseconds}ms committed={preparedUpdateCommitted}"

                    if updateSuperseded then
                        lintUpdateSuperseded <- true
                        logDiag $"Skip superseded prepared lint: {name} version={validatedDocumentVersion}"
                    elif skipIncrementalRefresh then
                        monitorLog Refresh $"RefreshIncrementalTypes skipped (exact version already indexed) file={name}"

                    let priorCallFiles =
                        if updateSuperseded
                           || skipIncrementalRefresh
                           || not (lintSnapshotStillCurrent ())
                           || priorDefsForRevalidation.IsEmpty then
                            []
                        else
                            gameStateLock.EnterReadLock()
                            try
                                referenceFilesForChangedDefinitions game name priorDefsForRevalidation
                            finally
                                gameStateLock.ExitReadLock()

                    let staged =
                        if not updateSuperseded
                           && lintSnapshotStillCurrent ()
                           && canTryIncrementalTypeRefresh
                           && not skipIncrementalRefresh then
                            let prepareReadWaitSw = Stopwatch.StartNew()
                            gameStateLock.EnterReadLock()
                            prepareReadWaitSw.Stop()
                            let prepareReadHoldSw = Stopwatch.StartNew()
                            let prepared =
                                try
                                    try
                                        let requiresScriptedServices =
                                            nonTypeSemanticChanged
                                            || (isDynamicDefinitionPath name
                                                && not definitionIdentityUnchanged)

                                        if requiresScriptedServices then
                                            game.PrepareScriptedTypes([ name ], true)
                                            |> Option.map ScriptedServices
                                        else
                                            match game with
                                            | :? IIncrementalTypeIndex as index ->
                                                match index.PrepareTypeIndex [ name ] with
                                                | Some stagedIndex when
                                                    isDynamicDefinitionPath name
                                                    && stagedIndex.semanticChanged ->
                                                    // A subtype/localisation-property change is not
                                                    // visible in the cheap identity signature.
                                                    game.PrepareScriptedTypes([ name ], true)
                                                    |> Option.map ScriptedServices
                                                | Some stagedIndex ->
                                                    Some(TypeIndexOnly(index, stagedIndex))
                                                | None -> None
                                            | _ -> None
                                    with e ->
                                        logDiag $"Incremental type prepare failed for {name}: reason=stage_prepare_failed error={e.Message}"
                                        None
                                finally
                                    prepareReadHoldSw.Stop()
                                    gameStateLock.ExitReadLock()
                            monitorLog Refresh
                                $"PrepareIncrementalTypes file={name} wait={prepareReadWaitSw.ElapsedMilliseconds}ms hold={prepareReadHoldSw.ElapsedMilliseconds}ms staged={prepared.IsSome}"
                            prepared
                        else
                            None

                    let mutable incrementalCommitSucceeded = false
                    let mutable incrementalSemanticChanged = false
                    let mutable incrementalCommitSuperseded = false
                    if not updateSuperseded && canTryIncrementalTypeRefresh && not skipIncrementalRefresh then
                        let commitWriteWaitSw = Stopwatch.StartNew()
                        enterGameStateWriteLock ()
                        commitWriteWaitSw.Stop()
                        let commitWriteHoldSw = Stopwatch.StartNew()
                        try
                            let gameStillCurrent =
                                match gameObj with
                                | Some g -> System.Object.ReferenceEquals(g, gameRefAtUpdate)
                                | None -> false
                            let committed =
                                if not gameStillCurrent || not (lintSnapshotStillCurrent ()) then
                                    incrementalCommitSuperseded <- true
                                    false
                                else
                                    match staged with
                                    | Some (ScriptedServices s) ->
                                        (try game.CommitScriptedTypes s
                                         with e ->
                                             logDiag $"Incremental type commit failed for {name}: {e.Message}"
                                             false)
                                    | Some (TypeIndexOnly(index, s)) ->
                                        (try index.CommitTypeIndex s
                                         with e ->
                                             logDiag $"Incremental type commit failed for {name}: {e.Message}"
                                             false)
                                    | None -> false

                            if committed then
                                incrementalCommitSucceeded <- true
                                incrementalSemanticChanged <-
                                    match staged with
                                    | Some (TypeIndexOnly(_, typeStage)) ->
                                        typeStage.semanticChanged || nonTypeSemanticChanged
                                    | Some (ScriptedServices scriptedStage) ->
                                        scriptedStage.semanticChanged || nonTypeSemanticChanged
                                    | None -> true
                                let semanticDelta =
                                    semanticDeltaForTypeIndex
                                        name
                                        (priorDefsForRevalidation |> Seq.map fst)
                                        incrementalSemanticChanged
                                validatedDocumentVersion
                                |> Option.iter (fun version ->
                                    committedTypeIndexVersions.[normaliseCachePath name] <- struct (version, game))

                                // A successfully committed stage is authoritative about
                                // the smallest safe publication unit. Do not promote an
                                // editor save to the multi-GB full RefreshCaches path just
                                // because the generic delta lacks a complete contribution
                                // description or a historical patch budget was reached.
                                let semanticDecision =
                                    match staged with
                                    | Some (ScriptedServices _) ->
                                        decideCommittedSemanticDelta
                                            CommittedSemanticStage.CommittedScriptedServices
                                            incrementalSemanticChanged
                                            semanticDelta
                                            incrementalScriptedPatchCount
                                            maxIncrementalScriptedPatchCount
                                    | Some (TypeIndexOnly _) ->
                                        decideCommittedSemanticDelta
                                            CommittedSemanticStage.CommittedTypeIndex
                                            incrementalSemanticChanged
                                            semanticDelta
                                            incrementalScriptedPatchCount
                                            maxIncrementalScriptedPatchCount
                                    | _ ->
                                        decideSemanticDelta
                                            semanticDelta
                                            incrementalScriptedPatchCount
                                            maxIncrementalScriptedPatchCount

                                match semanticDecision with
                                | SemanticDecision.SemanticNoOp ->
                                    clearTypeIndexCacheForFile name
                                    monitorLog Refresh $"RefreshIncrementalTypes semantic-noop file={name}"
                                | SemanticDecision.TypeIndexOnly ->
                                    // The staged index is already live. Advance only the
                                    // type model domain and revalidate known reverse users;
                                    // rebuilding rule/completion services would discard the
                                    // benefit of the atomic index patch.
                                    clearTypeCaches ()
                                    bumpTypesModelEpoch ()
                                    markFileStale name "types"
                                    completeRefreshDomains [ "types" ] "incremental_type_index"
                                    monitorLog Refresh
                                        $"RefreshIncrementalTypes decision=type-index-only file={name} changedKeys={semanticDelta.changedTypeKeys.Count}"
                                | SemanticDecision.ScriptedServices ->
                                    clearTypeCaches ()
                                    bumpTypesModelEpoch ()
                                    bumpRulesModelEpoch ()
                                    incrementalScriptedPatchCount <- incrementalScriptedPatchCount + 1
                                    markFileStale name "types"
                                    // Scripted services were rebuilt and atomically swapped by
                                    // CommitScriptedTypes. Only the independent localisation
                                    // diagnostic domain remains deferred.
                                    delayedScriptLocUpdate <- true
                                    pendingScriptLocalisationFiles.[name] <- 0uy
                                    addPendingRefreshDomains [ "localisation" ]
                                    completeRefreshDomains [ "types"; "rules" ] "incremental_scripted_services"
                                    monitorLog Refresh
                                        $"RefreshIncrementalTypes decision=scripted-services file={name} patch={incrementalScriptedPatchCount}/{maxIncrementalScriptedPatchCount}"
                                | SemanticDecision.FullRefresh reason ->
                                    clearTypeCaches ()
                                    bumpTypesModelEpoch ()
                                    incrementalScriptedPatchCount <- 0
                                    markFileStale name "types"
                                    needsTypeRefresh <- true
                                    lastTypeRefreshRequestAt <- DateTime.UtcNow
                                    addPendingRefreshDomains (semanticDelta.domains |> Set.toList)
                                    monitorLog Refresh
                                        $"RefreshIncrementalTypes decision=full file={name} reason={reason}"
                            elif incrementalCommitSuperseded then
                                monitorLog Refresh
                                    $"RefreshIncrementalTypes commit superseded file={name} reason=stage_guard_superseded; newer snapshot will decide refresh domains"
                            else
                                let fallbackReason =
                                    if staged.IsNone then "stage_prepare_failed" else "stage_commit_failed"
                                needsTypeRefresh <- true
                                lastTypeRefreshRequestAt <- DateTime.UtcNow
                                addPendingRefreshDomains [ "types"; "rules" ]
                                clearTypeCaches ()
                                markFileStale name "types"
                                incrementalScriptedPatchCount <- 0
                                monitorLog Refresh
                                    $"RefreshIncrementalTypes decision=full file={name} reason={fallbackReason}"
                        finally
                            commitWriteHoldSw.Stop()
                            exitGameStateWriteLock ()
                            if commitWriteHoldSw.ElapsedMilliseconds > writeLockHoldBudgetMs then
                                monitorLog Performance
                                    $"WriteLock hold budget exceeded file={name} phase=commitIncremental hold={commitWriteHoldSw.ElapsedMilliseconds}ms committed={incrementalCommitSucceeded}"
                        monitorLog Refresh
                            $"CommitIncrementalTypes file={name} wait={commitWriteWaitSw.ElapsedMilliseconds}ms hold={commitWriteHoldSw.ElapsedMilliseconds}ms committed={incrementalCommitSucceeded} semantic={incrementalSemanticChanged}"

                    if useInteractiveValidation
                       && not skipIncrementalRefresh
                       && not incrementalCommitSucceeded then
                        fileDiagnosticStates.Keys
                        |> Seq.toArray
                        |> Array.iter markFilePendingGlobalRevalidation

                    if incrementalCommitSucceeded then
                        // Cross-file call-site discovery only matters when validation-visible
                        // type metadata changed. Localisation is handled exactly once by the
                        // pending full/idle pass selected above.
                        gameStateLock.EnterReadLock()
                        try
                            let currentCallFiles =
                                if incrementalSemanticChanged then
                                    referenceFilesForChangedDefinitions game name (typeDefinitionsForFiles game [ name ])
                                else
                                    []
                            let revalidateFiles =
                                (if fastDefinitionIndex then [ name ] else []) @ priorCallFiles @ currentCallFiles
                                |> List.filter (fun file -> normaliseCachePath file <> normaliseCachePath name)
                                |> List.distinctBy normaliseCachePath
                            let revalidateFiles =
                                if fastDefinitionIndex then
                                    name :: revalidateFiles
                                    |> List.distinctBy normaliseCachePath
                                else
                                    revalidateFiles
                            if incrementalSemanticChanged && isDynamicDefinitionPath name then
                                let affectedFiles =
                                    name :: revalidateFiles
                                    |> List.map normaliseCachePath
                                    |> Set.ofList
                                let committedEpoch = modelEpochSnapshot ()
                                for kvp in fileDiagnosticStates do
                                    if not (affectedFiles.Contains(normaliseCachePath kvp.Key)) then
                                        updateFileDiagnosticState
                                            kvp.Key
                                            { kvp.Value with
                                                modelEpoch =
                                                    { kvp.Value.modelEpoch with
                                                        types = committedEpoch.types } }
                            if not revalidateFiles.IsEmpty then
                                if isEventDefinitionPath name then
                                    markDeferredRevalidationStale revalidateFiles
                                else
                                    scheduleDeferredDynamicRevalidation revalidateFiles
                            monitorLog Refresh $"RefreshIncrementalTypes file={name} semantic={incrementalSemanticChanged} patches={incrementalScriptedPatchCount} refs={revalidateFiles.Length}"
                        finally
                            gameStateLock.ExitReadLock()

                    let validatePreparedInteractively =
                        preparedUpdateCommitted
                        && not fastDefinitionIndex
                        && (useInteractiveValidation
                            || (stagedEditorUpdate
                                |> Option.exists (fun staged -> staged.kind = ShaderFile)))

                    let updateErrors =
                        if validatePreparedInteractively then
                            match stagedEditorUpdate with
                            | Some staged ->
                                gameStateLock.EnterReadLock()
                                try
                                    let result =
                                        match game with
                                        | :? ICancellableFileValidation as cancellable ->
                                            cancellable.ValidateFileInteractiveCancellable(
                                                staged,
                                                (fun () -> not (lintSnapshotStillCurrent ()))
                                            )
                                        | _ when lintSnapshotStillCurrent () ->
                                            Some(game.ValidateFileInteractive staged)
                                        | _ -> None

                                    match result with
                                    | Some completed ->
                                        validationModelEpochAtComputation <- Some(modelEpochSnapshot ())
                                        completed
                                    | None ->
                                        lintUpdateSuperseded <- true
                                        []
                                finally gameStateLock.ExitReadLock()
                            | None -> []
                        elif preparedUpdateCommitted
                             || fastDefinitionIndex
                             || (deferDeepValidation && (incrementalCommitSucceeded || not shallowAnalyze)) then
                            // The VFS already holds the new text from the earlier UpdateFile, so
                            // the deep (re-)validation only reads; the shared read lock lets
                            // completion requests run alongside it.
                            gameStateLock.EnterReadLock()
                            try
                                let result =
                                    match game with
                                    | :? ICancellableFileValidation as cancellable ->
                                        cancellable.ValidateFileCancellable(
                                            false,
                                            name,
                                            (fun () -> not (lintSnapshotStillCurrent ()))
                                        )
                                    | _ when lintSnapshotStillCurrent () ->
                                        Some(game.ValidateFile false name)
                                    | _ -> None

                                match result with
                                | Some completed ->
                                    validationModelEpochAtComputation <- Some(modelEpochSnapshot ())
                                    completed
                                | None ->
                                    lintUpdateSuperseded <- true
                                    []
                            finally gameStateLock.ExitReadLock()
                        else
                            updateErrors

                    let deferGlobalNegativeDiagnostics =
                        (useInteractiveValidation
                         && isIncrementalContributionCandidate name
                         && (not canTryIncrementalTypeRefresh
                             || (not skipIncrementalRefresh && not incrementalCommitSucceeded)))
                        || (canTryIncrementalTypeRefresh
                            && not skipIncrementalRefresh
                            && not incrementalCommitSucceeded)

                    if useInteractiveValidation
                       && isIncrementalContributionCandidate name
                       && not (isCurrentGameLocalisationFile name) then
                        lintDeferredGlobalKinds <- [ "localisation" ]

                    if deferGlobalNegativeDiagnostics then
                        lintDeferredGlobalKinds <-
                            lintDeferredGlobalKinds @ [ "types"; "rules" ]
                            |> List.distinct

                    let deferredGlobalErrors, updateErrors =
                        if deferGlobalNegativeDiagnostics then
                            updateErrors |> List.partition isUncertainGlobalNegativeError
                        else
                            [], updateErrors

                    if not deferredGlobalErrors.IsEmpty then
                        logDiag
                            $"Deferred {deferredGlobalErrors.Length} global negative diagnostic(s) for interactive file {name}"

                    let astErrors =
                        updateErrors
                        |> List.map (fun e ->
                            (e.code, e.severity, e.range.FileName, e.message, e.range, e.keyLength, e.relatedErrors))
                    let allocAfterUpdate = GC.GetTotalAllocatedBytes(false)
                    let updateMode =
                        if useInteractiveValidation && not fastDefinitionIndex then "interactive"
                        elif preparedUpdateCommitted then "prepared-deep"
                        else "full"
                    monitorLog Lint $"UpdateFile file={name} mode={updateMode} shallow={shallowAnalyze} allocDeltaMB={(allocAfterUpdate - allocBeforeUpdate) / 1048576L}{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"
                    
                    if isCurrentGameLocalisationFile name then
                        // We still need to call game.UpdateFile so the VFS gets the new text,
                        // but we rely on locCache/RefreshLocalisationCaches for the actual validation errors.
                        if isEditAction then
                            lintDeferredGlobalKinds <- [ "localisation" ]
                            parserErrors
                        else
                            parserErrors @ applicableCachedLocErrors
                    else
                        parserErrors @ applicableCachedLocErrors @ astErrors

            //-Publish diagnosis and update freshness status-
            let diagnosticsList =
                match errors with
                | [] -> []
                | x -> x |> List.map parserErrorToDiagnostics
            let visibleDiagnosticsList = diagnosticsList |> List.filter diagnosticFilter
            let validatedModelEpoch =
                validationModelEpochAtComputation |> Option.defaultWith modelEpochSnapshot

            // Publish to VS Code Problems panel. A lint of a dynamic definition
            // validates only the raw template, so it must not clear diagnostics
            // produced by parameterized call-site expansion. This also prevents
            // the post-RefreshCaches lint from racing and overwriting deferred
            // validation results after a slow Ctrl+S refresh.
            let refreshedCurrentDiagnostics = diagnosticsForFile name visibleDiagnosticsList
            let publishedCurrentDiagnostics =
                if isDynamicDefinitionPath name && not useInteractiveValidation then
                    DiagnosticMerge.mergeImmediateDefinitionDiagnostics
                        (existingDiagnosticsForFile name)
                        refreshedCurrentDiagnostics
                else
                    refreshedCurrentDiagnostics

            gameStateLock.EnterReadLock()
            try
                let currentModelEpoch = modelEpochSnapshot ()
                let canPublish =
                    not lintUpdateSuperseded
                    && lintSnapshotStillCurrent ()
                    && sameModelEpoch validatedModelEpoch currentModelEpoch

                if canPublish then
                    if not (isTypeIndexOnlyRefreshPath name) then
                        visibleDiagnosticsList
                        |> List.filter (fun (filePath, _) -> normaliseCachePath filePath <> normaliseCachePath name)
                        |> function
                            | [] -> ()
                            | otherDiagnostics -> sendDiagnostics otherDiagnostics

                    // Always publish the current file, including an empty complete result,
                    // so diagnostics removed by this exact document/model version are cleared.
                    client.PublishDiagnostics { uri = doc; diagnostics = publishedCurrentDiagnostics }

                    let newEpoch = System.Threading.Interlocked.Increment(diagnosticEpoch)
                    let pendingKinds =
                        pendingRefreshDomainList () @ lintDeferredGlobalKinds
                        |> List.distinct
                    let freshness =
                        if pendingKinds.IsEmpty then Fresh else Pending
                    setFileDiagnosticStateWithSnapshot
                        name
                        newEpoch
                        validatedDocumentVersion
                        validatedModelEpoch
                        freshness
                        pendingKinds
                        publishedCurrentDiagnostics

                    let validationPhase = if shallowAnalyze then "shallow-complete" else "deep-complete"
                    let pendingKindsText = String.concat "," pendingKinds
                    monitorLog Lint
                        $"Validation phase={validationPhase} file={name} documentVersion={validatedDocumentVersion} modelEpoch={validatedModelEpoch} freshness={freshness} diagnostics={publishedCurrentDiagnostics.Length} pending={pendingKindsText}"
                    client.CustomNotification(
                        "cwtools/validationComplete",
                        JsonValue.Record
                            [| "uri", JsonValue.String(doc.ToString())
                               "phase", JsonValue.String validationPhase
                               "documentVersion",
                                    JsonValue.Number(decimal (validatedDocumentVersion |> Option.defaultValue -1))
                               "diagnostics", JsonValue.Number(decimal publishedCurrentDiagnostics.Length) |]
                    )

                    if not (isTypeIndexOnlyRefreshPath name) then
                        visibleDiagnosticsList
                        |> List.groupBy fst
                        |> List.iter (fun (filePath, entries) ->
                            if normaliseCachePath filePath <> normaliseCachePath name then
                                setFileDiagnosticStateWithEpoch filePath newEpoch freshness pendingKinds (entries |> List.map snd))
                else
                    logDiag
                        $"Skip stale diagnostic publish file={name} version={validatedDocumentVersion} currentVersion={docs.GetVersionByPath(name)} modelMatch={sameModelEpoch validatedModelEpoch currentModelEpoch}"
            finally
                gameStateLock.ExitReadLock()
            if fastDefinitionIndex then
                committedInteractiveVersions.TryRemove(normaliseCachePath name) |> ignore
            perfLintCount <- perfLintCount + 1
            maybePerfReport "lint"
            if shallowAnalyze then
                flushCompletionRefreshForFile name
            return preparedCommitRetryRequested
        }

    let revalidateDeferredDynamicFiles (files: string list) =
        match gameObj with
        | None -> ()
        | Some game when not files.IsEmpty ->
            try
                if isCompletionHeavyInteractiveWindow () then
                    scheduleDeferredDynamicRevalidation files
                    logDiag $"Deferred revalidation yielded to completion activity files={files.Length}"
                else
                    let queued =
                        files
                        |> List.distinctBy normaliseCachePath
                    use _heavyAnalysisLease = acquireHeavyAnalysisGate ()
                    do
                        let batchModelEpoch = modelEpochSnapshot ()
                        let batchVersions =
                            queued |> List.map (fun filePath -> filePath, docs.GetVersionByPath(filePath))
                        let batchStillCurrent () =
                            sameModelEpoch batchModelEpoch (modelEpochSnapshot ())
                            && batchVersions
                               |> List.forall (fun (filePath, version) ->
                                   docs.GetVersionByPath(filePath) = version)

                        if not (batchStillCurrent ()) then
                            scheduleDeferredDynamicRevalidation queued
                            logDiag $"Deferred revalidation rescheduled stale batch before validation files={queued.Length}"
                        else
                            let allocBefore = GC.GetTotalAllocatedBytes(false)
                            let validationSw = Stopwatch.StartNew()
                            let refreshedResult =
                                gameStateLock.EnterReadLock()
                                try
                                    (try
                                        let warmSw = Stopwatch.StartNew()
                                        let warmed = game.ForceDynamicParameterDataForFiles queued
                                        warmSw.Stop()
                                        logDiag
                                            $"Deferred revalidation warmed {warmed} queued entities in {warmSw.ElapsedMilliseconds}ms"
                                     with e -> logDiag $"Deferred revalidation warm-up error: {e.Message}")

                                    game.ValidateFilesLocalCancellable(
                                        queued,
                                        (fun () -> not (batchStillCurrent ()))
                                    )
                                finally
                                    gameStateLock.ExitReadLock()
                            validationSw.Stop()

                            match refreshedResult with
                            | None ->
                                scheduleDeferredDynamicRevalidation queued
                                logDiag $"Deferred revalidation rescheduled superseded batch files={queued.Length}"
                            | Some refreshedErrors ->
                                let validatedModelEpoch = modelEpochSnapshot ()

                                let refreshedDynamicDiagnostics =
                                    refreshedErrors
                                    |> List.choose (fun e ->
                                        if isDynamicParameterError e.code e.message e.relatedErrors then
                                            Some(
                                                e.code,
                                                e.severity,
                                                e.range.FileName,
                                                e.message,
                                                e.range,
                                                e.keyLength,
                                                e.relatedErrors
                                            )
                                        else
                                            None)
                                    |> List.map parserErrorToDiagnostics
                                    |> List.filter diagnosticFilter

                                let refreshedByFile =
                                    refreshedDynamicDiagnostics
                                    |> List.groupBy (fst >> normaliseCachePath)
                                    |> Map.ofList
                                let filesToPublish =
                                    queued
                                    @ (refreshedDynamicDiagnostics |> List.map fst)
                                    |> List.distinctBy normaliseCachePath
                                let publishEpoch = nextDiagnosticEpoch ()

                                // A batch can publish dynamic-expansion diagnostics to files
                                // outside its own queue (cross-file call sites). Those files
                                // were neither revalidated nor republished by later batches,
                                // so a fixed error kept its stale diagnostic forever. Queue
                                // them for a follow-up batch so they get freshly revalidated
                                // and cleared when the underlying issue is gone.
                                let validatedFilePaths =
                                    filesToPublish
                                    |> List.map normaliseCachePath
                                    |> Set.ofList
                                let outstandingDynamicDiagnosticFiles =
                                    fileDiagnosticStates
                                    |> Seq.choose (fun kvp ->
                                        if kvp.Value.diagnostics |> List.exists DiagnosticMerge.isDynamicExpansionDiagnostic then
                                            if validatedFilePaths.Contains(normaliseCachePath kvp.Key) then
                                                None
                                            else
                                                Some kvp.Key
                                        else
                                            None)
                                    |> Seq.toList
                                if not outstandingDynamicDiagnosticFiles.IsEmpty then
                                    scheduleDeferredDynamicRevalidation outstandingDynamicDiagnosticFiles
                                    logDiag $"Deferred revalidation queued {outstandingDynamicDiagnosticFiles.Length} file(s) with outstanding dynamic diagnostics"

                                for filePath in filesToPublish do
                                    let refreshed =
                                        refreshedByFile
                                        |> Map.tryFind (normaliseCachePath filePath)
                                        |> Option.map (List.map snd)
                                        |> Option.defaultValue []
                                    let priorState =
                                        match fileDiagnosticStates.TryGetValue(filePath) with
                                        | true, state -> Some state
                                        | false, _ -> None
                                    let merged =
                                        DiagnosticMerge.mergeDeferredDefinitionDiagnostics
                                            (existingDiagnosticsForFile filePath)
                                            refreshed
                                    client.PublishDiagnostics { uri = diagnosticUri filePath; diagnostics = merged }

                                    let validatedVersion =
                                        priorState
                                        |> Option.bind _.validatedVersion
                                        |> Option.orElseWith (fun () -> docs.GetVersionByPath(filePath))
                                    let pendingKinds =
                                        priorState
                                        |> Option.map _.pendingGlobalKinds
                                        |> Option.defaultValue []
                                        |> List.filter (fun kind -> kind <> "dynamicParameters")
                                    let freshness =
                                        if validatedVersion <> docs.GetVersionByPath(filePath) then Stale
                                        elif pendingKinds.IsEmpty then Fresh
                                        else Pending
                                    setFileDiagnosticStateWithSnapshot
                                        filePath
                                        publishEpoch
                                        validatedVersion
                                        validatedModelEpoch
                                        freshness
                                        pendingKinds
                                        merged

                                let allocatedMB = (GC.GetTotalAllocatedBytes(false) - allocBefore) / 1048576L
                                monitorLog Lint
                                    $"ValidateFiles local dynamic batch files={queued.Length} diagnostics={refreshedDynamicDiagnostics.Length} elapsedMs={validationSw.ElapsedMilliseconds} allocDeltaMB={allocatedMB}{getPerfDiagnosticSnapshot()}"
            with e -> logDiag $"Deferred dynamic revalidation failed: {e.Message}"
        | _ -> ()

    let deferredRevalidationLock = obj ()
    let mutable pendingDeferredRevalidationFiles: Set<string> = Set.empty
    let mutable deferredRevalidationInFlight = false

    do
        scheduleDeferredDynamicRevalidationImpl <- fun (files: string list) ->
            let delay = max 0 dynamicDeferDelayMs
            let queued =
                files
                |> List.distinctBy normaliseCachePath
                |> List.truncate dynamicDeferMaxFiles
            if files.Length > dynamicDeferMaxFiles then
                logDiag $"Deferred dynamic revalidation capped files={files.Length} cap={dynamicDeferMaxFiles}"
            for path in queued do
                clearFileCaches path
                markFilePendingDynamicRevalidation path
            let shouldStart =
                lock deferredRevalidationLock (fun () ->
                    pendingDeferredRevalidationFiles <-
                        queued |> List.fold (fun acc f -> Set.add f acc) pendingDeferredRevalidationFiles
                    if deferredRevalidationInFlight then
                        false
                    else
                        deferredRevalidationInFlight <- true
                        true)
            if shouldStart then
                Task.Run(fun () ->
                    let mutable go = true
                    while go do
                        (try
                            if delay > 0 then System.Threading.Thread.Sleep(delay)
                            let batch =
                                lock deferredRevalidationLock (fun () ->
                                    let b = pendingDeferredRevalidationFiles |> Set.toList
                                    pendingDeferredRevalidationFiles <- Set.empty
                                    b)
                            if not batch.IsEmpty then revalidateDeferredDynamicFiles batch
                         with e -> logDiag $"Deferred dynamic revalidation scheduling failed: {e.Message}")
                        go <-
                            lock deferredRevalidationLock (fun () ->
                                if Set.isEmpty pendingDeferredRevalidationFiles then
                                    deferredRevalidationInFlight <- false
                                    false
                                else
                                    true))
                |> ignore

    let refreshDynamicCallSitesForDefinition (defFile: string) (priorDiagnostics: Diagnostic list) (isEditAction: bool) =
        let indexedCallFiles =
            if isEditAction && isDynamicDefinitionPath defFile then
                match gameObj with
                | Some game ->
                    try
                        gameStateLock.EnterReadLock()
                        try
                            let definitions = scriptedDefinitionsForFiles game [ defFile ]
                            referenceFilesForDefinitions game definitions
                        finally
                            gameStateLock.ExitReadLock()
                    with e ->
                        logDiag $"Indexed dynamic revalidation lookup failed for {defFile}: {e.Message}"
                        []
                | None -> []
            else
                []

        let refreshedInlineCallFiles =
            if isEditAction && isInlineScriptDefinitionPath defFile then
                match gameObj, tryInlineScriptNameFromPath defFile with
                | Some game, Some scriptName ->
                    try
                        let inlineWriteWaitSw = Stopwatch.StartNew()
                        enterGameStateWriteLock ()
                        inlineWriteWaitSw.Stop()
                        let inlineWriteHoldSw = Stopwatch.StartNew()
                        let refreshed =
                            try game.RefreshInlineScriptCallers [ scriptName ]
                            finally
                                exitGameStateWriteLock ()
                                inlineWriteHoldSw.Stop()
                                if inlineWriteHoldSw.ElapsedMilliseconds > writeLockHoldBudgetMs then
                                    monitorLog Performance
                                        $"WriteLock hold budget exceeded file={defFile} phase=inlineCaller wait={inlineWriteWaitSw.ElapsedMilliseconds}ms hold={inlineWriteHoldSw.ElapsedMilliseconds}ms"

                        for file in refreshed do
                            clearFileCaches file
                            markFileStale file "types"

                        if not refreshed.IsEmpty then
                            logDiag $"Refreshed {refreshed.Length} inline_script caller(s) for {defFile}"
                        refreshed
                    with e ->
                        logDiag $"Inline_script caller refresh failed for {defFile}: {e.Message}"
                        []
                | _ -> []
            else
                []

        let callFiles =
            (if isEditAction then
                 // Previous CW274D hints are only a source of stale call sites
                 // after the definition itself changed. A background batch is
                 // already consuming that work and must not schedule itself.
                 priorDiagnostics
                 |> List.filter (fun (d: Diagnostic) -> d.code = Some "CW274D")
                 |> List.collect (fun d -> d.relatedInformation)
                 |> List.map (fun ri -> getPathFromDoc ri.location.uri)
             else
                 [])
            @ indexedCallFiles
            @ refreshedInlineCallFiles
            |> List.distinctBy normaliseCachePath
        if not callFiles.IsEmpty then
            logDiag $"Refreshing {callFiles.Length} call-site file(s) for definition {defFile}"
            scheduleDeferredDynamicRevalidation (defFile :: callFiles)
        elif isEditAction && isDynamicDefinitionPath defFile then
            logDiag $"Scheduling deferred revalidation for edited dynamic definition {defFile}"
            scheduleDeferredDynamicRevalidation [ defFile ]

    let correctDynamicParameterValidationErrors context (game: IGame) (allErrors: CWError list) =
        if not deferDynamicParameterDiagnostics then
            allErrors
        else
            let dynamicErrors, plainErrors =
                allErrors
                |> List.partition (fun error ->
                    isDynamicParameterError error.code error.message error.relatedErrors)
            let candidateFiles =
                dynamicErrors
                |> List.collect (fun error ->
                    error.range.FileName
                    :: (error.relatedErrors
                        |> Option.defaultValue []
                        |> List.map (fun item -> item.location.FileName)))
                |> List.distinctBy normaliseCachePath

            if candidateFiles.IsEmpty || candidateFiles.Length > dynamicDeferMaxFiles then
                if candidateFiles.Length > dynamicDeferMaxFiles then
                    logDiag
                        $"Skipped {context} dynamic-parameter correction files={candidateFiles.Length} cap={dynamicDeferMaxFiles}"
                allErrors
            else
                let correctionSw = Stopwatch.StartNew()
                let allocBeforeCorrection = GC.GetTotalAllocatedBytes(false)
                let correctedDynamicErrors =
                    game.ValidateFilesLocalCancellable(candidateFiles, (fun () -> false))
                    |> Option.defaultValue []
                    |> List.filter (fun error ->
                        isDynamicParameterError error.code error.message error.relatedErrors)
                correctionSw.Stop()
                let correctionAllocatedMB =
                    (GC.GetTotalAllocatedBytes(false) - allocBeforeCorrection) / 1048576L
                logDiag
                    $"Corrected {dynamicErrors.Length} {context} dynamic-parameter diagnostics with one batch pass across {candidateFiles.Length} files; result={correctedDynamicErrors.Length} elapsedMs={correctionSw.ElapsedMilliseconds} allocDeltaMB={correctionAllocatedMB}"
                plainErrors @ correctedDynamicErrors

    let mutable delayTime = TimeSpan(0, 0, 5)

    let applyIncrementalLocalisationResult (result: IncrementalLocalisationResult) =
        for fileName in result.affectedFiles do
            locCache.TryRemove fileName |> ignore
            clearCacheWriteTimesForFile fileName
        for fileName, errors in result.errors |> List.groupBy _.range.FileName do
            cachePut locCache fileName errors


    let delayedAnalyze (forceGlobalRefresh: bool) =
        match gameObj with
        | Some game ->
            let analyzeSw = Stopwatch.StartNew()
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
            let doRefresh =
                needsTypeRefresh
                && (skipLimitReached
                    || forceGlobalRefresh
                    || (not (isCompletionActive ()) && quietEnough && cooldownElapsed))
            let serializeGlobalWork =
                doRefresh
                || delayedLocUpdate
                || (delayedScriptLocUpdate && now - lastScriptLocUpdateAt >= scriptLocUpdateCooldown)
            use _heavyAnalysisLease =
                if serializeGlobalWork then acquireHeavyAnalysisGate () else null
            let pendingDomainsText = String.concat "," pendingDomainsBeforeAnalyze
            monitorLog Lifecycle
                $"AnalyzeLifecycle stage=analyze-begin {lifecycleIdentity} force={forceGlobalRefresh} doRefresh={doRefresh} pending={pendingDomainsText} {getPerfMemorySnapshot()}"
            let mutable didGlobalWork = false
            // Staged full refresh: run the heavy rules rebuild under a read
            // lock against a lookup clone so completion/hover stay responsive, then commit
            // by swapping references under the write lock below. A stale or failed
            // staged result is discarded and retried after the next quiet period; the
            // heavy legacy RefreshCaches path is never run while holding the write lock.
            let stagedResourceEpoch = ResourceManagerEager.currentResource ()
            let mutable stagedRefresh = None
            if doRefresh then
                let prepareSw = Stopwatch.StartNew()
                let mutable prepareOutcome = "unavailable"
                monitorLog Lifecycle
                    $"AnalyzeLifecycle stage=prepare-before {lifecycleIdentity} resourceEpoch={stagedResourceEpoch} elapsedMs={analyzeSw.ElapsedMilliseconds} {getPerfMemorySnapshot()}"
                try
                    // The staged refresh owns its lookup clone and manager state.
                    stagedRefresh <- game.PrepareRefreshCaches()
                    prepareOutcome <- if stagedRefresh.IsSome then "prepared" else "unavailable"
                with e ->
                    prepareOutcome <- "failed"
                    logDiag $"PrepareRefreshCaches failed; keeping refresh pending: {e.Message}"
                prepareSw.Stop()
                monitorLog Lifecycle
                    $"AnalyzeLifecycle stage=prepare-after {lifecycleIdentity} outcome={prepareOutcome} elapsedMs={prepareSw.ElapsedMilliseconds} totalElapsedMs={analyzeSw.ElapsedMilliseconds} {getPerfMemorySnapshot()}"
            let mutable didLocRefresh = false
            let mutable didRefreshCaches = false
            let mutable gcPendingAfterRefresh = false
            let mutable gcPendingAfterLoc = false
            let refreshWriteWaitSw = Stopwatch.StartNew()
            enterGameStateWriteLock ()
            refreshWriteWaitSw.Stop()
            let refreshWriteHoldSw = Stopwatch.StartNew()
            try
                if doRefresh then
                    let hadStagedRefresh = stagedRefresh.IsSome
                    let resourceEpochStillCurrent =
                        stagedResourceEpoch = ResourceManagerEager.currentResource ()
                    let stagedCommitted =
                        match stagedRefresh, resourceEpochStillCurrent with
                        | Some staged, true ->
                            let commitSw = Stopwatch.StartNew()
                            let mutable commitOutcome = "rejected"
                            monitorLog Lifecycle
                                $"AnalyzeLifecycle stage=commit-before {lifecycleIdentity} resourceEpoch={stagedResourceEpoch} elapsedMs={analyzeSw.ElapsedMilliseconds} {getPerfMemorySnapshot()}"
                            let committed =
                                try
                                    let result = game.CommitRefreshCaches staged
                                    commitOutcome <- if result then "committed" else "rejected"
                                    result
                                with e ->
                                    commitOutcome <- "failed"
                                    logDiag $"CommitRefreshCaches failed; keeping refresh pending: {e.Message}"
                                    false
                            commitSw.Stop()
                            monitorLog Lifecycle
                                $"AnalyzeLifecycle stage=commit-after {lifecycleIdentity} outcome={commitOutcome} elapsedMs={commitSw.ElapsedMilliseconds} totalElapsedMs={analyzeSw.ElapsedMilliseconds} {getPerfMemorySnapshot()}"
                            committed
                        | _ -> false

                    // Drop guard references to the old lookup before localisation and GC.
                    stagedRefresh <- None

                    if stagedCommitted then
                        didRefreshCaches <- true
                        bumpGameModelEpoch ()
                        bumpRulesModelEpoch ()
                        bumpTypesModelEpoch ()
                        let allocAfterRefresh = GC.GetTotalAllocatedBytes(false)
                        refreshStatus <-
                            if forceGlobalRefresh then "refresh_caches_staged_forced"
                            else "refresh_caches_staged"
                        monitorLog Refresh $"RefreshCaches allocDeltaMB={(allocAfterRefresh - allocBefore) / 1048576L} staged=true force={forceGlobalRefresh} skipLimit={skipLimitReached} resourceEpoch={stagedResourceEpoch} {getPerfMemorySnapshot()}{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"
                        perfRefreshCachesCount <- perfRefreshCachesCount + 1
                        didGlobalWork <- true
                        gcPendingAfterRefresh <- true
                        needsTypeRefresh <- false
                        lastTypeRefreshCompletedAt <- DateTime.UtcNow
                        incrementalScriptedPatchCount <- 0
                        refreshSkipCount <- 0
                        let completed =
                            pendingDomainsBeforeAnalyze
                            |> List.filter (fun domain -> domain <> "localisation")
                            |> fun domains -> if domains.IsEmpty then [ "types" ] else domains
                        completeRefreshDomains completed refreshStatus
                    else
                        // An editor commit moved the resource/lookup guards while prepare
                        // ran, or preparation was unavailable. Reusing the candidate would
                        // be stale; rebuilding it under the write lock would recreate the
                        // original freeze and double peak allocation.
                        refreshStatus <-
                            if not resourceEpochStillCurrent then "staged_resource_superseded"
                            elif hadStagedRefresh then "staged_commit_rejected"
                            else "staged_prepare_unavailable"
                        lastTypeRefreshRequestAt <- DateTime.UtcNow
                        refreshSkipCount <- 0
                        monitorLog Refresh $"RefreshCaches {refreshStatus}; retrying after quiet period resourceEpoch={stagedResourceEpoch}->{ResourceManagerEager.currentResource ()}{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"
                elif needsTypeRefresh then
                    refreshSkipCount <- refreshSkipCount + 1
                    refreshStatus <- $"deferred:skip={refreshSkipCount};quiet={quietEnough};cooldown={cooldownElapsed};force={forceGlobalRefresh}"
                    monitorLog Refresh $"RefreshCaches skipped pending=true skip={refreshSkipCount} quiet={quietEnough} cooldown={cooldownElapsed} force={forceGlobalRefresh}{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"
                else
                    refreshSkipCount <- 0
                    refreshStatus <- "not_needed"
                    monitorLog Refresh $"RefreshCaches skipped pending=false{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"

                let allocBeforeLoc = GC.GetTotalAllocatedBytes(false)
                if delayedLocUpdate then
                    logDiag "delayedLocUpdate true"
                    let incrementalResult =
                        if didRefreshCaches then
                            None
                        else
                            match game with
                            | :? IIncrementalLocalisation as incremental ->
                                incremental.TakeLocalisationDelta()
                                |> Option.map incremental.ValidateLocalisationDelta
                            | _ -> None

                    match incrementalResult with
                    | Some result ->
                        applyIncrementalLocalisationResult result
                        monitorLog Localisation
                            $"LocErrors incremental keys/files affected={result.affectedFiles.Length} errors={result.errors.Length}"
                    | None ->
                        game.RefreshLocalisationCaches()
                        clearLocalisationDiagnosticCache ()
                        for fileName, errors in game.LocalisationErrors(true, true) |> List.groupBy _.range.FileName do
                            cachePut locCache fileName errors

                    bumpLocalisationModelEpoch ()
                    cachedLocMap <- None
                    cachedLocMapCount <- 0
                    delayedLocUpdate <- false
                    delayedScriptLocUpdate <- false
                    pendingScriptLocalisationFiles.Clear()
                    lastScriptLocUpdateAt <- now
                    didLocRefresh <- true
                    didGlobalWork <- true
                    completeRefreshDomains [ "localisation" ] "refresh_localisation"
                elif didRefreshCaches then
                    logDiag "delayedLocUpdate false"

                    clearLocalisationDiagnosticCache ()
                    for fileName, errors in game.LocalisationErrors(true, true) |> List.groupBy _.range.FileName do
                        cachePut locCache fileName errors
                    delayedScriptLocUpdate <- false
                    pendingScriptLocalisationFiles.Clear()
                    lastScriptLocUpdateAt <- now
                    bumpLocalisationModelEpoch ()
                    didLocRefresh <- true
                    if pendingDomainsBeforeAnalyze |> List.contains "localisation" then
                        completeRefreshDomains [ "localisation" ] "refresh_localisation_after_global"
                elif delayedScriptLocUpdate && now - lastScriptLocUpdateAt >= scriptLocUpdateCooldown then
                    logDiag "delayedScriptLocUpdate: recomputing mod loc errors"
                    let pendingFiles = pendingScriptLocalisationFiles.Keys |> Seq.toArray
                    match game, pendingFiles with
                    | (:? IIncrementalLocalisation as incremental), files when files.Length > 0 ->
                        incremental.ValidateLocalisationFiles files
                        |> applyIncrementalLocalisationResult
                    | _ ->
                        clearLocalisationDiagnosticCache ()
                        for fileName, errors in game.LocalisationErrors(true, false) |> List.groupBy _.range.FileName do
                            cachePut locCache fileName errors
                    delayedScriptLocUpdate <- false
                    pendingScriptLocalisationFiles.Clear()
                    lastScriptLocUpdateAt <- now
                    bumpLocalisationModelEpoch ()
                    didLocRefresh <- true
                    didGlobalWork <- true
                    completeRefreshDomains [ "localisation" ] "refresh_script_localisation"
                else
                    logDiag "LocErrors skipped: no localisation or type refresh"
                if didLocRefresh then evictIfNeeded locCache
                let allocAfterLoc = GC.GetTotalAllocatedBytes(false)
                if didLocRefresh then
                    let locErrorCount = locCache.Values |> Seq.sumBy List.length
                    monitorLog Localisation $"LocErrors allocDeltaMB={(allocAfterLoc - allocBeforeLoc) / 1048576L} locFiles={locCache.Count} locErrors={locErrorCount} cachedLocKeys={cachedLocMapCount}"
                    perfRefreshLocCount <- perfRefreshLocCount + 1
                else
                    monitorLog Localisation $"LocErrors skipped delayedLocUpdate={delayedLocUpdate} doRefresh={didRefreshCaches} locFiles={locCache.Count} cachedLocKeys={cachedLocMapCount}"
                if allocAfterLoc - allocBeforeLoc > gcThresholdBytes then
                    gcPendingAfterLoc <- true

                if didRefreshCaches then
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
                            updateFileDiagnosticState
                                kvp.Key
                                { kvp.Value with
                                    epoch = freshEpoch
                                    updatedAtUnixMs = nowMs
                                    freshness = nextFreshness
                                    pendingGlobalKinds = remainingPendingDomains }
            finally
                exitGameStateWriteLock ()
                refreshWriteHoldSw.Stop()
                if refreshWriteHoldSw.ElapsedMilliseconds > writeLockHoldBudgetMs then
                    monitorLog Performance
                        $"WriteLock hold budget exceeded phase=refresh wait={refreshWriteWaitSw.ElapsedMilliseconds}ms hold={refreshWriteHoldSw.ElapsedMilliseconds}ms didRefresh={didRefreshCaches} didLoc={didLocRefresh}"

            // Run heavy Gen2 collection outside the write lock so completion
            // reads are not blocked by GC. Skip when a completion window is
            // active to avoid stalling the editor.
            if (gcPendingAfterRefresh || gcPendingAfterLoc) && not (isCompletionActive ()) then
                GC.Collect(2, GCCollectionMode.Optimized, false, false)
                lastGCAllocBytes <- GC.GetTotalAllocatedBytes(false)
                monitorLog Memory "GC after global refresh (idle)"
            elif gcPendingAfterRefresh || gcPendingAfterLoc then
                monitorLog Memory "GC after global refresh deferred: completion active"

            if didRefreshCaches then
                fileDiagnosticStates
                |> Seq.map (fun kvp -> kvp.Key)
                |> Seq.toArray
                |> Array.iter markFilePendingGlobalRevalidation

            // Localisation-only refreshes update just that diagnostic domain;
            // avoid another whole-file lint while still replacing stale loc
            // diagnostics with results from the new localisation epoch.
            if didLocRefresh && not didRefreshCaches then
                let locPublishEpoch = nextDiagnosticEpoch ()
                let locModelEpoch = modelEpochSnapshot ()
                let filesWithOldLocDiagnostics =
                    fileDiagnosticStates
                    |> Seq.choose (fun kvp ->
                        if (kvp.Value.diagnostics |> List.exists isLocalisationDiagnostic)
                           || (kvp.Value.pendingGlobalKinds |> List.contains "localisation") then
                            Some kvp.Key
                        else
                            None)
                    |> Seq.toList
                let locFiles =
                    (locCache.Keys |> Seq.toList) @ filesWithOldLocDiagnostics
                    |> List.distinctBy normaliseCachePath
                let locErrorsByPath =
                    locCache
                    |> Seq.map (fun kvp -> normaliseCachePath kvp.Key, kvp.Value)
                    |> Map.ofSeq
                let processedLocFiles =
                    locFiles |> List.map normaliseCachePath |> Set.ofList

                for filePath in locFiles do
                    let refreshedLocDiagnostics =
                        match locErrorsByPath |> Map.tryFind (normaliseCachePath filePath) with
                        | Some errors ->
                            errors
                            |> List.map (fun e ->
                                (e.code, e.severity, e.range.FileName, e.message, e.range, e.keyLength, e.relatedErrors))
                            |> List.map parserErrorToDiagnostics
                            |> List.filter diagnosticFilter
                            |> diagnosticsForFile filePath
                        | None -> []

                    let existing = existingDiagnosticsForFile filePath
                    let merged =
                        DiagnosticMerge.replaceDomain
                            isLocalisationDiagnostic
                            existing
                            refreshedLocDiagnostics
                    client.PublishDiagnostics { uri = diagnosticUri filePath; diagnostics = merged }

                    let priorState =
                        match fileDiagnosticStates.TryGetValue(filePath) with
                        | true, state -> Some state
                        | false, _ -> None
                    let validatedVersion = priorState |> Option.bind _.validatedVersion
                    let pendingKinds =
                        priorState
                        |> Option.map _.pendingGlobalKinds
                        |> Option.defaultValue [ "validation" ]
                        |> List.filter (fun kind -> kind <> "localisation")
                    let freshness =
                        if validatedVersion <> docs.GetVersionByPath(filePath) then Stale
                        elif pendingKinds.IsEmpty then Fresh
                        else Pending
                    setFileDiagnosticStateWithSnapshot
                        filePath
                        locPublishEpoch
                        validatedVersion
                        locModelEpoch
                        freshness
                        pendingKinds
                        merged

                // The refresh also proves that files outside locFiles still have
                // no localisation diagnostics, so their non-localisation results
                // can advance to the new localisation epoch unchanged.
                for kvp in fileDiagnosticStates do
                    if not (processedLocFiles.Contains(normaliseCachePath kvp.Key)) then
                        updateFileDiagnosticState
                            kvp.Key
                            { kvp.Value with
                                modelEpoch =
                                    { kvp.Value.modelEpoch with
                                        localisation = locModelEpoch.localisation } }

            if not didRefreshCaches then
                flushAllCompletionRefreshes ()

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
            // This scans all known files, so only do it after a real structural rebuild
            // (RefreshCaches); a loc-only recompute changes no file set.
            if didRefreshCaches then
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
                        removeFileDiagnosticState staleKey |> ignore
                with e ->
                    logDiag $"CleanupCache failed: {e.Message}"
            
            // L6/L3 Fix: Use non-blocking Gen2 GC only after a full refresh to
            // reclaim large rule data; avoid frequent mid-stream GC in hot path.
            // A loc-only recompute does not warrant a gen2 collection.
            if didRefreshCaches then maybeCollectGarbage ()

            // Memory diagnostics: track growth sources after each analyze pass.
            let allocTotal = GC.GetTotalAllocatedBytes(false)
            let sm = CWTools.Utilities.StringResource.stringManager
            monitorLog Memory $"AnalyzePass cycleAllocMB={(allocTotal - allocBefore) / 1048576L} strings={sm.StringCount} ints={sm.IntCount} {getPerfMemorySnapshot()}{getPerfDiagnosticSnapshot()}{getPerfCacheSnapshot()}"
            maybePerfReport "delayedAnalyze"
            analyzeSw.Stop()
            monitorLog Lifecycle
                $"AnalyzeLifecycle stage=analyze-complete {lifecycleIdentity} elapsedMs={analyzeSw.ElapsedMilliseconds} didGlobalWork={didGlobalWork} didRefresh={didRefreshCaches} status={refreshStatus} {getPerfMemorySnapshot()}"
            didGlobalWork, didRefreshCaches
        | None ->
            updateValidationRuntime (fun state ->
                { state with
                    lastAnalyzeElapsedMs = 0L
                    lastAnalyzeCompletedAtUnixMs = nowUnixMs ()
                    lastAnalyzeDidGlobalWork = false
                    lastRefreshStatus = "no_game" })
            false, false


    let lintAgent =
        MailboxProcessor.Start(fun agent ->
            let mutable nextAnalyseTime = DateTime.Now
            let mutable needsDeepAnalyse = false
            let activeLintPaths =
                System.Collections.Concurrent.ConcurrentDictionary<string, byte>()

            let analyzeTask (file: VersionedTextDocumentIdentifier) (options: LintRequestOptions) (isEditAction: bool) =
                async {
                    let uri = file.uri
                    let mutable nextTime = nextAnalyseTime
                    let cycleSw = Stopwatch.StartNew()
                    let mutable errorMessage: string option = None
                    let mutable ownedLintGeneration: (string * int64) option = None

                    try
                        try
                            let lintPath = getPathFromDoc uri
                            
                            let alreadyFresh =
                                (not isEditAction)
                                && (not options.forceDeepLint)
                                && (match fileDiagnosticStates.TryGetValue(lintPath) with
                                    | true, state ->
                                        state.freshness = Fresh
                                        && sameModelEpoch state.modelEpoch (modelEpochSnapshot ())
                                    | _ -> false)
                            let supersededEdit =
                                isEditAction
                                && file.version > 0
                                && (docs.GetVersion(FileInfo(uri.LocalPath))
                                    |> Option.exists (fun currentVersion -> currentVersion > file.version))
                            if alreadyFresh then
                                logDiag $"Skip open/focus lint (already fresh): {lintPath}"
                            elif supersededEdit then
                                logDiag $"Skip superseded edit lint: {lintPath} requested={file.version}"
                            else
                                let shallowAnalyse = DateTime.Now < nextTime
                                let useShallowAnalyze =
                                    if options.fastDefinitionIndex then
                                        true
                                    else
                                        (shallowAnalyse || isEditAction) && (not options.forceDeepLint)
                                updateValidationRuntime (fun state ->
                                    { state with
                                        inProgress = true
                                        inProgressFile = uri.LocalPath
                                        lastStartedAtUnixMs = nowUnixMs ()
                                        lastCycleFile = uri.LocalPath
                                        lastCycleShallow = useShallowAnalyze
                                        lastCycleEditAction = isEditAction
                                        lastError = None })
                                logDiag $"lint forceDeep={options.forceDeepLint}, forceGlobal={options.forceGlobalRefresh}, fastDefinitionIndex={options.fastDefinitionIndex}, forceDisk={options.forceDisk}, shallow={useShallowAnalyze}"
                                let requestGeneration = lintGeneration lintPath
                                ownedLintGeneration <- Some(lintPath, requestGeneration)
                                let requestStillCurrent () = lintGeneration lintPath = requestGeneration
                                let priorDiagnostics =
                                    match fileDiagnosticStates.TryGetValue(lintPath) with
                                    | true, state -> state.diagnostics
                                    | _ -> []
                                // Open/focus never changes the VFS. Re-validating the
                                // current cached entity under the read lock avoids a
                                // redundant UpdateFile write lock, which previously
                                // blocked completion, CodeLens and semantic tokens.
                                let validateCachedOnly = not isEditAction
                                let! preparedRetryRequested =
                                    lint uri useShallowAnalyze options.forceDisk isEditAction validateCachedOnly options.fastDefinitionIndex requestStillCurrent

                                if preparedRetryRequested && requestStillCurrent () then
                                    markFileStale lintPath "prepared-retry"
                                    needsDeepAnalyse <- true

                                    if options.preparedRetryCount < maxPreparedCommitRetries then
                                        let nextRetry = options.preparedRetryCount + 1
                                        let retryOptions = { options with preparedRetryCount = nextRetry }
                                        let retryDelayMs = 100 * nextRetry
                                        let retryDocumentVersion = docs.GetVersionByPath lintPath
                                        monitorLog Lint
                                            $"Prepared commit retry scheduled file={lintPath} attempt={nextRetry}/{maxPreparedCommitRetries} delayMs={retryDelayMs}"
                                        Task.Run(fun () ->
                                            System.Threading.Thread.Sleep retryDelayMs
                                            if docs.GetVersionByPath(lintPath) = retryDocumentVersion then
                                                agent.Post(UpdateRequest(file, retryOptions)))
                                        |> ignore
                                    else
                                        monitorLog Lint
                                            $"Prepared commit retry exhausted file={lintPath} attempts={options.preparedRetryCount}; diagnostics remain pending"
                                else
                                    // Deep passes and the explicit fast-definition save path schedule
                                    // cross-file revalidation; ordinary shallow keystrokes still skip it.
                                    if requestStillCurrent ()
                                       && (not useShallowAnalyze || options.fastDefinitionIndex) then
                                        refreshDynamicCallSitesForDefinition lintPath priorDiagnostics isEditAction

                                    if requestStillCurrent () && not useShallowAnalyze then
                                        let _, requiresFileRelint = delayedAnalyze options.forceGlobalRefresh
                                        logDiag "lint after delayed"
                                        if requiresFileRelint then
                                            let! _ = lint uri true false false false false requestStillCurrent
                                            ()
                                        nextTime <- DateTime.Now.Add(delayTime)
                                        needsDeepAnalyse <- needsTypeRefresh || delayedLocUpdate || delayedScriptLocUpdate
                                    else
                                        needsDeepAnalyse <- true
                        with e ->
                            errorMessage <- Some e.Message
                            logError $"uri %A{uri.LocalPath} \n exception %A{e}"
                    finally
                        cycleSw.Stop()
                        activeLintPaths.TryRemove(normaliseCachePath uri.LocalPath) |> ignore
                        ownedLintGeneration
                        |> Option.iter (fun (filePath, generation) ->
                            releaseLintGeneration filePath generation)
                        updateValidationRuntime (fun state ->
                            { state with
                                inProgress = false
                                inProgressFile = ""
                                lastCompletedAtUnixMs = nowUnixMs ()
                                lastCycleElapsedMs = int64 (cycleSw.Elapsed.TotalMilliseconds)
                                lastError = errorMessage })
                        agent.Post(WorkComplete(nextTime))
                } |> Async.StartAsTask

            let analyze (file: VersionedTextDocumentIdentifier) options isEditAction =
                //eprintfn "Analyze %s" (file.uri.ToString())
                activeLintPaths.[normaliseCachePath file.uri.LocalPath] <- 0uy
                analyzeTask file options isEditAction |> ignore

            let shouldYieldLintStart (file: VersionedTextDocumentIdentifier) isEditAction =
                isEditAction
                && isCompletionHeavyEditPath file.uri.LocalPath
                && (isCompletionActive () || gameStateLock.CurrentReadCount > 0)

            let postDelayedLintRequest (msg: LintRequestMsg) =
                Task.Run(fun () ->
                    System.Threading.Thread.Sleep(lintStartYieldDelayMs)
                    agent.Post msg)
                |> ignore

            let startOrDeferAnalyze file options isEditAction state =
                if shouldYieldLintStart file isEditAction then
                    logDiag $"Yield lint start for interactive completion file={file.uri.LocalPath} readers={gameStateLock.CurrentReadCount}"
                    postDelayedLintRequest (UpdateRequest(file, options))
                    false, state
                else
                    analyze file options isEditAction
                    true, state

            let rec loop (inprogress: bool) (state: Map<string, VersionedTextDocumentIdentifier * LintRequestOptions * bool>) =
                async {
                    updateValidationRuntime (fun runtime -> { runtime with queueDepth = state.Count })
                    let waitTimeMs =
                        if not inprogress && state.IsEmpty && needsDeepAnalyse then
                            let remaining = int (nextAnalyseTime - DateTime.Now).TotalMilliseconds
                            Math.Max(500, Math.Min(2500, remaining))
                        else
                            -1

                    let! msgOpt = agent.TryReceive(waitTimeMs)

                    if state.Count > 0 then
                        logDiag $"queue length: %i{state.Count}"

                    match msgOpt, inprogress with
                    | Some (UpdateRequest(ur, options)), false ->
                        let inprogress, state = startOrDeferAnalyze ur options true state  // UpdateRequest is always an edit action
                        return! loop inprogress state
                    | Some (UpdateRequest(ur, options)), true ->
                        match Map.tryFind ur.uri.LocalPath state with
                        | Some (prevUr, prevOptions, _) ->
                            let newest =
                                if ur.version > prevUr.version then ur else prevUr
                            return! loop inprogress (state |> Map.add ur.uri.LocalPath (newest, mergeLintRequestOptions options prevOptions, true))
                        | None ->
                            return! loop inprogress (state |> Map.add ur.uri.LocalPath (ur, options, true))
                    // DidOpen / DidFocus: deep lint without marking needsTypeRefresh
                    | Some (OpenRequest ur), false ->
                        analyze ur normalLintRequest false  // not an edit action
                        return! loop true state
                    | Some (OpenRequest ur), true ->
                        if activeLintPaths.ContainsKey(normaliseCachePath ur.uri.LocalPath) then
                            // didOpen and the active-editor focus notification commonly
                            // arrive back-to-back. The running pass observes the same
                            // DocumentStore version, so a second validation is redundant.
                            return! loop inprogress state
                        elif not (Map.containsKey ur.uri.LocalPath state) then
                            return! loop inprogress (state |> Map.add ur.uri.LocalPath (ur, normalLintRequest, false))
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

                            let next, options, isEdit = state.[key]
                            let newstate = state |> Map.remove key
                            let inprogress, newstate = startOrDeferAnalyze next options isEdit newstate
                            return! loop inprogress newstate
                    | None, false ->
                        logDiag "Idle timeout: triggering background delayedAnalyze"
                        let _, requiresFileRelint = delayedAnalyze false
                        needsDeepAnalyse <- needsTypeRefresh || delayedLocUpdate || delayedScriptLocUpdate
                        nextAnalyseTime <- DateTime.Now.Add(delayTime)

                        if requiresFileRelint then
                            for doc in docs.OpenFiles() do
                                let uri = filePathToUri(doc.FullName)
                                let generation = lintGeneration doc.FullName
                                let requestStillCurrent () = lintGeneration doc.FullName = generation
                                let! _ = lint uri true false false false false requestStillCurrent  // idle re-lint is never an edit
                                ()

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
            let rec loop (pending: Map<string, VersionedTextDocumentIdentifier * LintRequestOptions>) (deferCount: int) =
                async {
                    updateValidationRuntime (fun runtime -> { runtime with debounceQueueDepth = pending.Count })
                    let pendingFastIndex =
                        pending
                        |> Map.exists (fun _ (_, options) -> options.fastDefinitionIndex)
                    // Fast definition-index saves get a short debounce so Ctrl+S followed by
                    // typing can merge into the edit stream instead of grabbing the write lock.
                    let debounceMs = if pendingFastIndex then 180 else 1500
                    let! msgOpt = agent.TryReceive(debounceMs)
                    match msgOpt with
                    | Some (UpdateRequest(ur, options)) when options.forceDeepLint && not options.fastDefinitionIndex ->
                        lintAgent.Post(UpdateRequest(ur, options))
                        return! loop (pending |> Map.remove ur.uri.LocalPath) 0
                    | Some (UpdateRequest(ur, options)) ->
                        // New edit arrived reset the debounce timer
                        let newest, merged =
                            match Map.tryFind ur.uri.LocalPath pending with
                            | Some (existing, existingOptions) ->
                                let newest = if existing.version > ur.version then existing else ur
                                newest, mergeLintRequestOptions options existingOptions
                            | None -> ur, options
                        return! loop (pending |> Map.add ur.uri.LocalPath (newest, merged)) 0
                    | Some (OpenRequest ur) ->
                        // Open requests bypass debounce - forward immediately
                        lintAgent.Post(OpenRequest ur)
                        return! loop pending deferCount
                    | Some (WorkComplete _) ->
                        // Ignore WorkComplete messages in debounce agent
                        return! loop pending deferCount
                    | None ->
                        // Timeout: 1.5s of inactivity forward to lintAgent
                        if not pending.IsEmpty then
                            let pendingFastIndex =
                                pending
                                |> Map.exists (fun _ (_, options) -> options.fastDefinitionIndex)
                            if pendingFastIndex && isCompletionHeavyTypingWindow () then
                                return! loop pending deferCount
                            elif isCompletionActive () && deferCount < maxDebounceDefer then
                                return! loop pending (deferCount + 1)
                            else
                                for _, (ur, options) in pending |> Map.toSeq do
                                    lintAgent.Post(UpdateRequest(ur, options))
                                return! loop Map.empty 0
                        else
                            return! loop pending 0
                }
            loop Map.empty 0)

    let mutable rulesUpdateGeneration = 0L
    let rulesUpdateTimeoutMs = 15_000
    let rulesUpdateGate = new System.Threading.SemaphoreSlim(1, 1)

    /// Select an immediately available local source. The remote check is
    /// intentionally started only after processWorkspace has built a usable
    /// game model, so slow GitHub access cannot block completion or indexing.
    let setupRulesCaches () =
        semanticCatalogCache <- None
        let generation = System.Threading.Interlocked.Increment(&rulesUpdateGeneration)
        preferBundledRules <- shouldPreferBundledRulesAtStartup useManualRules
        let source = getConfigSource cachePath useManualRules manualRulesFolder bundledRulesPath preferBundledRules
        let status =
            match useManualRules, source with
            | true, "manual" -> "manual"
            | true, _ -> "missing"
            | false, "bundled" -> "startup_bundled"
            | false, "remote" -> "startup_cached"
            | _ -> "missing"
        updateLoadingRuntime (fun state ->
            { state with
                lastRulesStatus = status
                lastRulesSource = source
                lastError = None })
        generation, cachePath, remoteRepoPath, useManualRules, rulesChannel, activeGame

    /// Bump this when the serialized vanilla cache format or serializer inputs
    /// become incompatible with caches produced by older extension builds.
    let vanillaCacheSchemaVersion = 2

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
                            client.CustomNotification(
                                "vanillaCacheGenerated",
                                JsonValue.Record
                                    [| "gameId", JsonValue.String(promptName)
                                       "message", JsonValue.String(text) |]
                            )
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
        client.CustomNotification(
            "loadingBar",
            JsonValue.Record [| "value", JsonValue.String(""); "enable", JsonValue.Boolean(false) |]
        )

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
                      preferBundledRules = preferBundledRules
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
                    clearFileDiagnosticStates ()
                    latestLintGenerations.Clear()
                    committedInteractiveVersions.Clear()
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
                        if hasStellarisVanillaData serverSettings then
                            let game = loadSTL serverSettings
                            stlGameObj <- Some(game :> IGame<STLComputedData>)
                            game :> IGame
                        else
                            logInfo "No Stellaris vanilla data (game path or cache); using the generic game instead"
                            activeGame <- Custom
                            let game = loadCustom serverSettings
                            customGameObj <- Some(game :> IGame<JominiComputedData>)
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

                (try
                    let preflightSw = Stopwatch.StartNew()
                    let forced =
                        game.ForceDynamicParameterData(dynamicPreflightTimeoutMs, dynamicPreflightMaxEntities)
                    preflightSw.Stop()
                    logDiag
                        $"Dynamic parameter preflight forced {forced} entities in {preflightSw.ElapsedMilliseconds}ms (timeout {dynamicPreflightTimeoutMs}ms, cap {dynamicPreflightMaxEntities})"
                 with e -> logDiag $"Dynamic parameter preflight error: {e.Message}")

                let valErrorRaw =
                    game.ValidationErrors()
                    |> correctDynamicParameterValidationErrors "initial" game
                let valErrors =
                    valErrorRaw
                    |> List.map (fun e ->
                        (e.code, e.severity, e.range.FileName, e.message, e.range, e.keyLength, e.relatedErrors))

                validationErrorCount <- valErrorRaw.Length

                let locRaw = game.LocalisationErrors(true, true)
                localisationErrorCount <- locRaw.Length
                clearLocalisationDiagnosticCache ()
                cachedLocMap <- None
                cachedLocMapCount <- 0
                for fileName, errors in locRaw |> List.groupBy _.range.FileName do
                    cachePut locCache fileName errors

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

    let rulesUpdateIsCurrent generation startupCachePath startupRemoteRepoPath startupRulesChannel startupGame =
        System.Threading.Volatile.Read(&rulesUpdateGeneration) = generation
        && cachePath = Some startupCachePath
        && remoteRepoPath = Some startupRemoteRepoPath
        && not useManualRules
        && rulesChannel = startupRulesChannel
        && activeGame = startupGame

    let finishBackgroundRulesUpdate
        generation
        startupCachePath
        startupRemoteRepoPath
        startupRulesChannel
        startupGame
        elapsedMs
        rulesResult
        updateError =
        if rulesUpdateIsCurrent generation startupCachePath startupRemoteRepoPath startupRulesChannel startupGame then
            enterGameStateWriteLock ()
            try
                if rulesUpdateIsCurrent generation startupCachePath startupRemoteRepoPath startupRulesChannel startupGame then
                    let previousSource =
                        getConfigSource cachePath useManualRules manualRulesFolder bundledRulesPath preferBundledRules
                    let remoteUpdateSucceeded =
                        match rulesResult with
                        | Some (_, Some _) -> true
                        | _ -> false
                    let remoteRulesChanged =
                        match rulesResult with
                        | Some (changed, Some _) -> changed
                        | _ -> false

                    preferBundledRules <-
                        shouldPreferBundledRulesAfterRemoteUpdate useManualRules remoteUpdateSucceeded
                    let finalSource =
                        getConfigSource cachePath useManualRules manualRulesFolder bundledRulesPath preferBundledRules

                    let mutable rulesStatus = "unknown"
                    let mutable rulesError = updateError
                    let mutable userMessage: (MessageType * string) option = None

                    match rulesResult, finalSource with
                    | Some (true, Some date), "remote" ->
                        rulesStatus <- "updated"
                        logInfo (String.Format(LangResources.rulesUpdated, activeGame, date))
                    | Some (false, Some _), "remote" ->
                        rulesStatus <- "up_to_date"
                        logInfo "CWTools rules are already up-to-date."
                    | _, "bundled" ->
                        rulesStatus <- "fallback"
                        let warningMsg =
                            uiText
                                (sprintf "Failed to update CWTools rules for %A from the remote repository. Loaded the bundled fallback rules instead." activeGame)
                                (sprintf "无法从远程仓库更新 %A 的 CWTools 规则，已改用内置备用规则。" activeGame)
                        logWarning warningMsg
                        userMessage <- Some (MessageType.Warning, warningMsg)
                    | _, "remote" ->
                        rulesStatus <- "fallback"
                        let warningMsg =
                            uiText
                                (sprintf "Failed to update CWTools rules for %A from the remote repository. The bundled fallback was unavailable, so the existing cached rules were kept." activeGame)
                                (sprintf "无法从远程仓库更新 %A 的 CWTools 规则；内置备用规则不可用，因此继续使用现有缓存规则。" activeGame)
                        logWarning warningMsg
                        userMessage <- Some (MessageType.Warning, warningMsg)
                    | _ ->
                        rulesStatus <- "missing"
                        let errorMsg =
                            uiText
                                (sprintf "Failed to update or load CWTools rules for %A. No bundled fallback or usable remote cache was found. Reinstall the VSIX or run the package script again, then run 'CWTools: Run Installation Health Check'." activeGame)
                                (sprintf "无法更新或加载 %A 的 CWTools 规则，未找到内置备用规则或可用的远程缓存。请重新安装 VSIX 或重新运行打包脚本，然后运行“CWTools: 运行安装健康检查”。" activeGame)
                        rulesError <- Some errorMsg
                        logError errorMsg
                        userMessage <- Some (MessageType.Error, errorMsg)

                    updateLoadingRuntime (fun state ->
                        { state with
                            lastCompletedAtUnixMs = nowUnixMs ()
                            lastElapsedMs = elapsedMs
                            lastRulesStatus = rulesStatus
                            lastRulesSource = finalSource
                            lastError = rulesError })

                    match userMessage with
                    | Some (messageType, message) ->
                        client.ShowMessage({ ``type`` = messageType; message = message })
                    | None -> ()

                    if finalSource <> previousSource || remoteRulesChanged then
                        semanticCatalogCache <- None
                        bumpGameModelEpoch ()
                        bumpRulesModelEpoch ()
                        bumpTypesModelEpoch ()
                        bumpLocalisationModelEpoch ()
                        processWorkspace rootUri
            finally
                exitGameStateWriteLock ()

    let startRulesUpdateInBackground
        (generation, startupCachePath, startupRemoteRepoPath, startupUseManualRules, startupRulesChannel, startupGame) =
        match startupCachePath, startupRemoteRepoPath, startupUseManualRules with
        | Some cp, Some rp, false ->
            let stable = startupRulesChannel <> "latest"
            updateLoadingRuntime (fun state ->
                { state with
                    lastRulesStatus = "updating_background"
                    lastRulesSource =
                        getConfigSource cachePath useManualRules manualRulesFolder bundledRulesPath preferBundledRules
                    lastError = None })

            let updateTask =
                Task.Run(fun () ->
                    let sw = Stopwatch.StartNew()
                    rulesUpdateGate.Wait()
                    try
                        try
                            // A failed background attempt already leaves the local model usable;
                            // do not repeat the same potentially slow network operation here.
                            let result = Some (initOrUpdateRules rp cp stable false)
                            sw.Stop()
                            result, None, int64 sw.ElapsedMilliseconds
                        with e ->
                            sw.Stop()
                            logError $"Failed to update CWTools rules in the background: {e.Message}"
                            None, Some e.Message, int64 sw.ElapsedMilliseconds
                    finally
                        rulesUpdateGate.Release() |> ignore)

            let supervisor =
                task {
                    let timeoutTask = Task.Delay(rulesUpdateTimeoutMs)
                    let! firstCompleted = Task.WhenAny(updateTask :> Task, timeoutTask)
                    if Object.ReferenceEquals(firstCompleted, timeoutTask)
                       && rulesUpdateIsCurrent generation cp rp startupRulesChannel startupGame then
                        let timeoutMessage =
                            $"Background CWTools rules update exceeded {rulesUpdateTimeoutMs}ms; continuing with the local rules source."
                        logWarning timeoutMessage
                        updateLoadingRuntime (fun state ->
                            { state with
                                lastRulesStatus = "background_timeout"
                                lastError = Some timeoutMessage })

                    let! rulesResult, updateError, elapsedMs = updateTask
                    finishBackgroundRulesUpdate
                        generation
                        cp
                        rp
                        startupRulesChannel
                        startupGame
                        elapsedMs
                        rulesResult
                        updateError
                }

            supervisor.ContinueWith(fun (completed: Task) ->
                if completed.IsFaulted then
                    logError $"Background CWTools rules update supervisor failed: {completed.Exception.GetBaseException().Message}")
            |> ignore
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
            with
            | :? OperationCanceledException as cancellation ->
                return raise cancellation
            | ex ->
                client.LogMessage
                    { ``type`` = MessageType.Error
                      message = $"%A{ex}" }

                return defaultValue
        }


    let parseUri path =
        let inner p =
            let uri = filePathToUri p
            Some(uri.AbsoluteUri |> JsonValue.String)

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

                    match opt.Item("defaultRepoPath") with
                    | JsonValue.String x ->
                        logInfo $"default repo path %A{x}"
                        defaultRemoteRepoPath <- Some x
                    | _ -> ()

                    match opt.Item("repoPath") with
                    | JsonValue.String x ->
                        logInfo $"repo path %A{x}"
                        if defaultRemoteRepoPath.IsNone then
                            defaultRemoteRepoPath <- Some x
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
                        | x ->
                            useManualRules <- false
                            rulesChannel <- x
                    | _ -> ()

                | None -> ()

                logInfo (sprintf "New init %A" p)

                let triggerChars = LSP.Types.defaultCompletionOptions.triggerCharacters
                logInfo (sprintf "Server initializing. Completion trigger chars configured: %A" triggerChars)
                // '=' pops value completion right at `key =` — without it, parameter/enum
                // value suggestions only appear via Ctrl+Space or a lucky first letter.
                let caps = [ "."; "|"; "$"; "=" ]
                logInfo (sprintf "Sending capabilities with completion trigger chars: %A" caps)

                return
                    { capabilities =
                        { defaultServerCapabilities with
                            hoverProvider = true
                            signatureHelpProvider = Some defaultSignatureHelpOptions
                            definitionProvider = true
                            referencesProvider = true
                            documentHighlightProvider = true
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
                                          "cwtools.ai.exploreProject"
                                          "cwtools.ai.exportProjectKnowledge"
                                          "cwtools.ai.queryProjectKnowledgeDb"
                                          "cwtools.ai.getSemanticCatalog"
                                          "cwtools.ai.queryScriptedEffects"
                                          "cwtools.ai.queryScriptedTriggers"
                                          "cwtools.ai.queryEnums"
                                          "cwtools.ai.getEntityInfo"
                                          "cwtools.ai.queryStaticModifiers"
                                          "cwtools.ai.queryVariables"
                                          "cwtools.ai.queryOverrideModes"
                                          "cwtools.ai.getDiagnosticsFresh"
                                          "cwtools.ai.waitDiagnosticsFresh"
                                          "cwtools.ai.getValidationStatus"
                                          "cwtools.ai.parseFragment"
                                          "cwtools.ai.shader.symbols"
                                          "cwtools.ai.shader.compileUnit"
                                          "cwtools.ai.shader.variants"
                                          "cwtools.ai.shader.callers"
                                          "cwtools.ai.shader.reachability"
                                          "cwtools.ai.shader.validate"
                                          "cwtools.ai.shader.preflightEdit"
                                          "cwtools.ai.shader.compareVanilla"
                                          "cwtools.exportTypes"
                                          "getFileTypes" ] }
                            inlayHintProvider = true
                            foldingRangeProvider = true
                            selectionRangeProvider = true
                            callHierarchyProvider = true
                            renameProvider =
                                JsonValue.Record [| "prepareProvider", JsonValue.Boolean true |]
                            semanticTokensProvider =
                                Some
                                    { legend =
                                        { tokenTypes =
                                            [ "namespace"; "type"; "function"; "variable"; "parameter"
                                              "property"; "enumMember"; "keyword"; "number"; "string"
                                              "comment"; "operator"; "macro"; "decorator" ]
                                          tokenModifiers = [ "declaration"; "definition"; "readonly"; "inactive" ] }
                                      full = true
                                      range = false
                                      delta = true } } }
            }

        member this.Initialized() = async { () }
        member this.Shutdown() = async { return None }

        member this.DidChangeConfiguration(p: DidChangeConfigurationParams) =
            async {
                let config =
                    match p.settings.TryGetProperty("stellarisLanguageServices") with
                    | Some x -> x
                    | None ->
                        match p.settings.TryGetProperty("cwtools") with
                        | Some x -> x
                        | None -> p.settings

                let configValue path =
                    ((Some config), path)
                    ||> List.fold (fun current key ->
                        match current with
                        | Some value -> value.TryGetProperty(key)
                        | None -> None)
                    |> Option.defaultValue JsonValue.Null

                let newLanguages =
                    match langConfigMap |> List.tryFind (fun (g, _, _) -> g = activeGame) with
                    | Some (_, parse, defaultFn) ->
                        match configValue ["localisation"; "languages"] with
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
                    // Language priority changed: drop the cached loc map so hover/inlay rebuild in the new primary language.
                    cachedLocMap <- None
                    cachedLocMapCount <- 0

                match configValue ["localisation"; "generated_strings"] with
                | JsonValue.String newString -> generatedStrings <- updateIfChanged generatedStrings newString
                | _ -> ()

                let newVanillaOnly =
                    match configValue ["errors"; "vanilla"] with
                    | JsonValue.Boolean b -> b
                    | _ -> validateVanilla

                validateVanilla <- updateIfChanged validateVanilla newVanillaOnly

                match configValue ["experimental"] with
                | JsonValue.Boolean b -> experimental <- b
                | _ -> ()

                match configValue ["debug_mode"] with
                | JsonValue.Boolean b -> debugMode <- b
                | _ -> ()

                let newIgnoreCodes =
                    match configValue ["errors"; "ignore"] with
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
                    match configValue ["errors"; "ignorefiles"] with
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
                    match configValue ["ignore_patterns"] with
                    | JsonValue.Array o ->
                        o
                        |> Array.choose (function
                            | JsonValue.String s -> Some s
                            | _ -> None)
                    | _ -> dontLoadPatterns

                if dontLoadPatterns <> excludePatterns then
                    dontLoadPatterns <- excludePatterns
                    requiresReload <- true

                match configValue ["rules_version"] with
                | JsonValue.String x ->
                    let newUseManualRules = x = "manual"
                    if useManualRules <> newUseManualRules then
                        useManualRules <- newUseManualRules
                        requiresReload <- true
                    if rulesChannel <> x then
                        rulesChannel <- x
                        requiresReload <- true
                | _ -> ()

                match configValue ["rules_remote_url"] with
                | JsonValue.String x ->
                    let trimmed = x.Trim()
                    let newRemoteRepoPath =
                        if String.IsNullOrWhiteSpace trimmed then defaultRemoteRepoPath
                        else Some trimmed
                    if remoteRepoPath <> newRemoteRepoPath then
                        remoteRepoPath <- newRemoteRepoPath
                        requiresReload <- true
                | _ -> ()

                match configValue ["trace"; "server"] with
                | JsonValue.String "messages"
                | JsonValue.String "verbose" -> loglevel <- LogLevel.Verbose
                | _ -> ()

                for (configKey, getter, setter) in vanillaPathMap do
                    match configValue ["cache"; configKey] with
                    | JsonValue.String "" -> ()
                    | JsonValue.String s -> 
                        let old = getter () |> Option.defaultValue ""
                        if old <> s then
                            setter (Some s)
                            requiresReload <- true
                    | _ -> ()


                match configValue ["rules_folder"] with
                | JsonValue.String x -> 
                    let old = manualRulesFolder |> Option.defaultValue ""
                    if old <> x then
                        manualRulesFolder <- Some x
                        requiresReload <- true
                | _ -> ()

                match configValue ["showInlineText"] with
                | JsonValue.Boolean x -> showInlineText <- x
                | _ -> ()

                match configValue ["maxFileSize"] with
                | JsonValue.Number x -> maxFileSize <- int x
                | _ -> ()

                let applyDiagnosticsConfig () =
                    match configValue ["diagnostics"; "deferDynamicParameterDiagnostics"] with
                    | JsonValue.Boolean b -> deferDynamicParameterDiagnostics <- b
                    | _ -> ()
                    match configValue ["diagnostics"; "dynamicPreflightTimeoutMs"] with
                    | JsonValue.Number x -> dynamicPreflightTimeoutMs <- max 0 (int x)
                    | _ -> ()
                    match configValue ["diagnostics"; "dynamicPreflightMaxEntities"] with
                    | JsonValue.Number x -> dynamicPreflightMaxEntities <- max 0 (int x)
                    | _ -> ()
                    match configValue ["diagnostics"; "dynamicDeferDelayMs"] with
                    | JsonValue.Number x -> dynamicDeferDelayMs <- max 0 (int x)
                    | _ -> ()
                applyDiagnosticsConfig ()

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
                            let initWriteWaitSw = Stopwatch.StartNew()
                            enterGameStateWriteLock ()
                            initWriteWaitSw.Stop()
                            let initWriteHoldSw = Stopwatch.StartNew()
                            let rulesUpdate =
                                try
                                    let snapshot = setupRulesCaches ()
                                    checkOrSetGameCache false
                                    bumpGameModelEpoch ()
                                    bumpRulesModelEpoch ()
                                    bumpTypesModelEpoch ()
                                    bumpLocalisationModelEpoch ()
                                    processWorkspace rootUri
                                    snapshot
                                finally
                                    exitGameStateWriteLock ()
                                    initWriteHoldSw.Stop()
                                    if initWriteHoldSw.ElapsedMilliseconds > writeLockHoldBudgetMs then
                                        monitorLog Performance
                                            $"WriteLock hold budget exceeded phase=gameInit wait={initWriteWaitSw.ElapsedMilliseconds}ms hold={initWriteHoldSw.ElapsedMilliseconds}ms"

                            startRulesUpdateInBackground rulesUpdate)

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
                advanceLintGeneration path |> ignore
                dirtyDocumentPaths.[normaliseCachePath path] <- 0uy
                if isCompletionHeavyEditPath path then
                    markCompletionHeavyTextEditActivity ()
                    clearFileCachesPreservingSemanticTokens path
                else
                    forgetFileCaches path
                // Clear the deep validation cache for this file to ensure that shallow lint does not return the old errors before the fix
                match gameObj with
                | Some game -> game.InvalidateFileCache path
                | None -> ()
                markFileStale path "edit"
                // Diagnostics from the previous document version are not safe to
                // retain while the new version is waiting in the debounce queue.
                client.PublishDiagnostics { uri = p.textDocument.uri; diagnostics = [] }
                monitorLog Lint
                    $"Validation phase=diagnostics-cleared file={path} documentVersion={p.textDocument.version} modelEpoch={modelEpochSnapshot ()} freshness=stale"

                // Use debounce agent instead of immediate lint.
                // Lint will fire after 1.5s of typing inactivity.
                // This prevents the write lock (game.UpdateFile) from blocking
                // read requests (Completion, Hover, SemanticTokens) during rapid typing.
                lintDebounceAgent.Post(
                    UpdateRequest(
                        { uri = p.textDocument.uri
                          version = p.textDocument.version },
                        normalLintRequest  // Let the lint agent use shallow passes while typing; save/focus still forces deep lint.
                    )
                )
            }

        member this.WillSaveTextDocument(_: WillSaveTextDocumentParams) =
            // No-op: DidSaveTextDocument posts the appropriate save validation request.
            async { () }

        // P0 Fix: was TODO() return empty edit list instead of crashing
        member this.WillSaveWaitUntilTextDocument(_: WillSaveTextDocumentParams) = async { return [] }

        member this.DidSaveTextDocument(p: DidSaveTextDocumentParams) =
            async {
                let path = getPathFromDoc p.textDocument.uri
                let wasDirty, _ = dirtyDocumentPaths.TryRemove(normaliseCachePath path)
                if wasDirty then
                    advanceLintGeneration path |> ignore
                    if isCompletionHeavyEditPath path then
                        markCompletionHeavySaveActivity ()
                    let requestOptions =
                        if isScriptedDefinitionPath path then
                            fastDefinitionIndexRequest
                        else
                            deepLintRequest
                    lintDebounceAgent.Post(
                        UpdateRequest(
                            { uri = p.textDocument.uri
                              version = 0 },
                            requestOptions
                        )
                    )
                else
                    logDiag $"Skip unchanged save validation: {path}"
            }

        member this.DidCloseTextDocument(p: DidCloseTextDocumentParams) = async { 
            docs.Close p 
            let localPath = p.textDocument.uri.LocalPath
            let fullPath = try FileInfo(localPath).FullName with _ -> localPath
            committedTypeIndexVersions.TryRemove(normaliseCachePath localPath) |> ignore
            committedTypeIndexVersions.TryRemove(normaliseCachePath fullPath) |> ignore
            // Clean all file-level caches to prevent memory leaks from closed files
            forgetFileCaches localPath
            forgetFileCaches fullPath
            dirtyDocumentPaths.TryRemove(normaliseCachePath localPath) |> ignore
            dirtyDocumentPaths.TryRemove(normaliseCachePath fullPath) |> ignore
            pendingCompletionRefresh.TryRemove(normaliseCachePath localPath) |> ignore
            pendingCompletionRefresh.TryRemove(normaliseCachePath fullPath) |> ignore
            committedInteractiveVersions.TryRemove(normaliseCachePath fullPath) |> ignore
            (locCache :> System.Collections.Generic.IDictionary<_, _>).Remove(localPath) |> ignore
            match gameObj with
            | Some game -> game.InvalidateFileCache fullPath
            | None -> ()
            clearRangeCache ()
        }

        member this.DidChangeWatchedFiles(p: DidChangeWatchedFilesParams) =
            async {
                let mutable refreshFileList = false
                for change in p.changes do
                    match change.``type`` with
                    | FileChangeType.Created
                    | FileChangeType.Changed ->
                        if change.``type`` = FileChangeType.Created then
                            refreshFileList <- true
                        let path = getPathFromDoc change.uri
                        let isOpenDocumentSaveEcho =
                            change.``type`` = FileChangeType.Changed
                            && (match docs.GetTextByPath(path) with
                                | Some openText ->
                                    try String.Equals(openText, File.ReadAllText(path), StringComparison.Ordinal)
                                    with _ -> false
                                | None -> false)
                        if isOpenDocumentSaveEcho then
                            // VS Code reports an on-disk Changed event after didSave,
                            // including Ctrl+S when no bytes changed. The open-document
                            // pipeline already owns real edits, so replaying the watcher
                            // event would parse and refresh the same file a second time.
                            logDiag $"Skip open-document watched-file save echo: {path}"
                        else
                            advanceLintGeneration path |> ignore
                            forgetFileCaches path
                            match gameObj with
                            | Some game -> game.InvalidateFileCache path
                            | None -> ()
                            // Creation and external change both enter the staged semantic-delta
                            // pipeline. A newly created file with an unknown contribution
                            // will still choose FullRefresh, while known type/scripted
                            // contributions can commit incrementally.
                            lintDebounceAgent.Post(UpdateRequest({ uri = change.uri; version = 0 }, diskRefreshRequest))
                    | FileChangeType.Deleted ->
                        refreshFileList <- true
                        let path = getPathFromDoc change.uri
                        committedTypeIndexVersions.TryRemove(normaliseCachePath path) |> ignore
                        if isCurrentGameLocalisationFile path then
                            match gameObj with
                            | Some (:? IIncrementalLocalisation as incremental) ->
                                let deleteWriteWaitSw = Stopwatch.StartNew()
                                enterGameStateWriteLock ()
                                deleteWriteWaitSw.Stop()
                                let deleteWriteHoldSw = Stopwatch.StartNew()
                                try
                                    try
                                        let result = incremental.RemoveLocalisationFile path
                                        applyIncrementalLocalisationResult result
                                        bumpLocalisationModelEpoch ()
                                        cachedLocMap <- None
                                        cachedLocMapCount <- 0
                                        delayedLocUpdate <- false
                                        completeRefreshDomains [ "localisation" ] "incremental_localisation_delete"
                                        monitorLog Localisation
                                            $"RemoveLocalisation file={path} affected={result.affectedFiles.Length} errors={result.errors.Length}"
                                    with e ->
                                        delayedLocUpdate <- true
                                        addPendingRefreshDomains [ "localisation" ]
                                        logDiag $"Incremental localisation delete failed for {path}: reason=stage_commit_failed error={e.Message}"
                                finally
                                    exitGameStateWriteLock ()
                                    deleteWriteHoldSw.Stop()
                                    if deleteWriteHoldSw.ElapsedMilliseconds > writeLockHoldBudgetMs then
                                        monitorLog Performance
                                            $"WriteLock hold budget exceeded file={path} phase=deleteLocalisation wait={deleteWriteWaitSw.ElapsedMilliseconds}ms hold={deleteWriteHoldSw.ElapsedMilliseconds}ms"
                            | _ ->
                                delayedLocUpdate <- true
                                addPendingRefreshDomains [ "localisation" ]
                                monitorLog Localisation
                                    $"RemoveLocalisation decision=full file={path} reason=capability_unavailable"
                        elif incrementalTypeRefreshEnabled () && isIncrementalContributionCandidate path then
                            match gameObj with
                            | Some game ->
                                let mutable handled = false
                                let mutable definitionsForRevalidation: (string * string) list = []
                                let deleteWriteWaitSw = Stopwatch.StartNew()
                                enterGameStateWriteLock ()
                                deleteWriteWaitSw.Stop()
                                let deleteWriteHoldSw = Stopwatch.StartNew()
                                try
                                    try
                                        definitionsForRevalidation <-
                                            if isDynamicDefinitionPath path then
                                                scriptedDefinitionsForFiles game [ path ]
                                            else
                                                typeDefinitionsForFiles game [ path ]
                                        handled <-
                                            if isDynamicDefinitionPath path then
                                                game.RemoveScriptedTypes [ path ]
                                            else
                                                match game with
                                                | :? IIncrementalTypeIndex as index -> index.RemoveTypeIndex [ path ]
                                                | _ -> false
                                    with e ->
                                        logDiag $"Incremental scripted delete failed for {path}: reason=stage_commit_failed error={e.Message}"
                                        handled <- false
                                finally
                                    exitGameStateWriteLock ()
                                    deleteWriteHoldSw.Stop()
                                    if deleteWriteHoldSw.ElapsedMilliseconds > writeLockHoldBudgetMs then
                                        monitorLog Performance
                                            $"WriteLock hold budget exceeded file={path} phase=delete wait={deleteWriteWaitSw.ElapsedMilliseconds}ms hold={deleteWriteHoldSw.ElapsedMilliseconds}ms"

                                if handled then
                                    bumpTypesModelEpoch ()
                                    let callFiles =
                                        if definitionsForRevalidation.IsEmpty then
                                            []
                                        else
                                            gameStateLock.EnterReadLock()
                                            try
                                                referenceFilesForChangedDefinitions game path definitionsForRevalidation
                                            finally
                                                gameStateLock.ExitReadLock()
                                    incrementalScriptedPatchCount <- incrementalScriptedPatchCount + 1
                                    clearTypeCaches ()
                                    let revalidateFiles =
                                        callFiles
                                        |> List.filter (fun file -> normaliseCachePath file <> normaliseCachePath path)
                                    if not revalidateFiles.IsEmpty then
                                        if isEventDefinitionPath path then
                                            markDeferredRevalidationStale revalidateFiles
                                        else
                                            scheduleDeferredDynamicRevalidation revalidateFiles
                                    monitorLog Refresh $"RemoveScriptedTypes file={path} patches={incrementalScriptedPatchCount} refs={revalidateFiles.Length}"

                                    if isTypeIndexOnlyRefreshPath path then
                                        completeRefreshDomains [ "types" ] "incremental_type_index_delete"
                                    elif incrementalScriptedPatchCount >= maxIncrementalScriptedPatchCount then
                                        needsTypeRefresh <- true
                                        lastTypeRefreshRequestAt <- DateTime.UtcNow
                                        addPendingRefreshDomains [ "types"; "rules" ]
                                        incrementalScriptedPatchCount <- 0
                                else
                                    needsTypeRefresh <- true
                                    lastTypeRefreshRequestAt <- DateTime.UtcNow
                                    addPendingRefreshDomains [ "types"; "rules" ]
                                    clearTypeCaches ()
                                    incrementalScriptedPatchCount <- 0
                                    monitorLog Refresh
                                        $"RemoveIncrementalTypes decision=full file={path} reason=stage_commit_failed"
                            | None -> ()
                        elif isIncrementalContributionCandidate path then
                            needsTypeRefresh <- true
                            lastTypeRefreshRequestAt <- DateTime.UtcNow
                            let domains =
                                refreshDomainsForPath path @ [ "types"; "rules" ]
                                |> List.filter (fun domain -> domain <> "localisation")
                                |> List.distinct
                            addPendingRefreshDomains domains
                            clearTypeCaches ()
                            monitorLog Refresh
                                $"RemoveIncrementalTypes decision=full file={path} reason=capability_unavailable"
                        client.PublishDiagnostics { uri = change.uri; diagnostics = [] }
                        forgetFileCaches path
                        removeFileDiagnosticState path |> ignore

                if refreshFileList then
                    gameObj |> Option.iter queueFileListRefresh
            }

        member this.Completion(p: CompletionParams) =
            async {
                let sw = Stopwatch.StartNew()
                let allocBefore = GC.GetTotalAllocatedBytes(false)
                let filePath = getPathFromDoc p.textDocument.uri
                clearMatchingCompletionRefresh p
                updateCompletionRuntime (fun state ->
                    { state with
                        lastStartedAtUnixMs = nowUnixMs ()
                        lastFile = filePath
                        lastLine = p.position.line
                        lastCharacter = p.position.character
                        lastError = None })
                let fileText = docs.GetText(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue ""
                let hash = contentHash fileText
                let cacheKey =
                    CompletionText.completionCacheKey
                        (normaliseCachePath filePath)
                        hash
                        p.position.line
                        p.position.character
                        debugMode
                        clientSupportsInsertReplaceEdit
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
                        uiText
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
                        let shaderPath = getPathFromDoc p.textDocument.uri
                        let shaderText = docs.GetText(FileInfo(shaderPath)) |> Option.defaultValue ""
                        if PdxShaderFeatures.isShaderFile shaderPath then
                            PdxShaderFeatures.signatureHelpAt
                                (game.AllFiles())
                                (PosHelper.fromZ p.position.line p.position.character)
                                shaderPath
                                shaderText
                            |> Option.map (fun help ->
                                { signatures =
                                    help.signatures
                                    |> List.map (fun signature ->
                                        { label = signature.label
                                          documentation = signature.documentation
                                          parameters =
                                            signature.parameters
                                            |> List.map (fun parameter ->
                                                { label = parameter.label
                                                  documentation = parameter.documentation }) })
                                  activeSignature = Some help.activeSignature
                                  activeParameter = Some help.activeParameter })
                        else
                            let allEffects = game.ScriptedEffects() @ game.ScriptedTriggers()
                            let effectNames = allEffects |> Seq.map (fun e -> e.Name.GetString()) |> System.Collections.Generic.HashSet

                            // Try word under cursor first
                            let word = docs.GetTextAtPosition(p.textDocument.uri, p.position)
                            let directMatch =
                                if String.IsNullOrWhiteSpace word then None
                                else allEffects |> List.tryFind (fun e -> e.Name.GetString() = word)

                            // Walk source backwards to find enclosing effect block.
                            let findEnclosing () =
                                let lines = shaderText.Split('\n')
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

                            match effectName |> Option.bind (fun name -> allEffects |> List.tryFind (fun e -> e.Name.GetString() = name)) with
                            | Some effect ->
                                let paramMatches = scriptedParamRegex.Matches(
                                    match effect with
                                    | :? ScriptedEffect as se -> se.Comments
                                    | _ -> "")
                                let paramNames =
                                    [ for m in paramMatches -> m.Groups.[1].Value ]
                                    |> List.distinct
                                if paramNames.IsEmpty then None
                                else
                                    let parameters =
                                        paramNames
                                        |> List.map (fun parameterName ->
                                            { label = "$" + parameterName + "$"
                                              documentation = Some(sprintf "Parameter: %s" parameterName) })
                                    let scopes = String.Join(", ", effect.Scopes |> List.map string)
                                    Some
                                        { signatures =
                                            [ { label = effect.Name.GetString() + "(" + String.Join(", ", paramNames) + ")"
                                                documentation = if String.IsNullOrWhiteSpace scopes then None else Some(sprintf "Scopes: %s" scopes)
                                                parameters = parameters } ]
                                          activeSignature = Some 0
                                          activeParameter = None }
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
                            |> Option.orElseWith (fun () ->
                                match tryDefinitionInjectionKeyAtLine fileContent p.position.line with
                                | Some info when
                                    p.position.character >= info.keyStart
                                    && p.position.character <= info.keyEnd
                                    ->
                                    tryFindDefinitionInjectionTarget game info.target |> Option.map (fun (_, tdi) -> tdi.range)
                                | _ -> None)

                        match gototype with
                        | Some goto ->
                            [ { uri = filePathToUri(goto.FileName)
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
                        let text = docs.GetText(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue ""

                        let gototype =
                            if PdxShaderFeatures.isShaderFile path then
                                Some(PdxShaderFeatures.referencesAt (game.AllFiles()) position path text)
                            else
                                game.FindAllRefs position path text

                        match gototype with
                        | Some gotos ->
                            gotos
                            |> List.map (fun goto ->
                                { uri = filePathToUri(goto.FileName)
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
                        let text = docs.GetText(FileInfo(p.textDocument.uri.LocalPath)) |> Option.defaultValue ""

                        let refs =
                            if PdxShaderFeatures.isShaderFile path then
                                Some(PdxShaderFeatures.referencesAt (game.AllFiles()) position path text)
                            else
                                game.FindAllRefs position path text

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

            let symbolScore query (typeName: string) (id: string) =
                if String.IsNullOrWhiteSpace query then 0
                else
                    let typeName = typeName.ToLowerInvariant()
                    let id = id.ToLowerInvariant()
                    if id = query then 0
                    elif id.StartsWith(query) then 1
                    elif typeName = query then 2
                    elif typeName.StartsWith(query) then 3
                    elif id.Contains(query) then 4
                    elif typeName.Contains(query) then 5
                    else 6

            async {
                return
                    match gameObj with
                    | Some game ->
                        let types = game.Types()
                        let query = p.query.ToLowerInvariant()

                        let scriptSymbols =
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
                                        let kind = symbolKindForType typeName
                                        { name = tdi.id
                                          kind = kind
                                          location =
                                            { uri = filePathToUri(tdi.range.FileName)
                                              range = convRangeToLSPRange tdi.range }
                                          containerName = Some typeName }))
                        let shaderKind declarationKind =
                            match declarationKind with
                            | PdxShaderRuntime.EffectDeclaration -> SymbolKind.Method, "shader.effect"
                            | PdxShaderRuntime.HlslFunctionDeclaration -> SymbolKind.Function, "shader.function"
                            | PdxShaderRuntime.HlslTypeDeclaration
                            | PdxShaderRuntime.VertexStructDeclaration -> SymbolKind.Class, "shader.type"
                            | PdxShaderRuntime.ConstantBufferDeclaration -> SymbolKind.Module, "shader.constant_buffer"
                            | PdxShaderRuntime.SamplerDeclaration
                            | PdxShaderRuntime.ShaderResourceDeclaration
                            | PdxShaderRuntime.HlslVariableDeclaration -> SymbolKind.Variable, "shader.variable"
                            | PdxShaderRuntime.MacroDeclaration -> SymbolKind.Constant, "shader.macro"
                            | PdxShaderRuntime.BlendStateDeclaration
                            | PdxShaderRuntime.DepthStencilStateDeclaration
                            | PdxShaderRuntime.RasterizerStateDeclaration -> SymbolKind.Enum, "shader.state"
                            | PdxShaderRuntime.VertexMainCodeDeclaration
                            | PdxShaderRuntime.PixelMainCodeDeclaration
                            | PdxShaderRuntime.GeometryMainCodeDeclaration -> SymbolKind.Function, "shader.maincode"
                        let openDocuments =
                            docs.OpenFiles()
                            |> List.choose (fun file ->
                                if PdxShaderFeatures.isShaderFile file.FullName then
                                    docs.GetText file |> Option.map (fun text -> file.FullName, text)
                                else None)
                        let shaderSymbols =
                            PdxShaderRuntime.buildModel
                                (if activeGame = STL then stlGameVersion else None)
                                (game.AllFiles())
                                openDocuments
                            |> _.declarations
                            |> List.choose (fun declaration ->
                                let kind, container = shaderKind declaration.kind
                                if query.Length > 0
                                   && not (declaration.name.ToLowerInvariant().Contains(query))
                                   && not (container.Contains(query)) then None
                                else
                                    Some
                                        { name = declaration.name
                                          kind = kind
                                          location =
                                            { uri = filePathToUri(declaration.file)
                                              range = convRangeToLSPRange declaration.selectionRange }
                                          containerName = Some container })
                        scriptSymbols @ shaderSymbols
                        |> List.distinctBy (fun symbol -> symbol.name, symbol.containerName, symbol.location.uri, symbol.location.range.start.line, symbol.location.range.start.character)
                        |> List.sortBy (fun symbol ->
                            let container = symbol.containerName |> Option.defaultValue ""
                            symbolScore query container symbol.name, symbol.name.Length, symbol.name, container)
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
                        let shaderActions =
                            if PdxShaderFeatures.isShaderFile path then
                                Some
                                    [ { title = "Validate shader compile unit"
                                        command = "cwtools.ai.shader.validate"
                                        arguments =
                                            [ JsonValue.Record
                                                [| "uri", JsonValue.String(p.textDocument.uri.ToString()) |] ] } ]
                            else None

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

                        let definitionInjectionModeActions =
                            let fileText = docs.GetText(FileInfo(path)) |> Option.defaultValue ""
                            match tryDefinitionInjectionKeyAtLine fileText p.range.start.line with
                            | Some info when p.range.start.character <= info.keyEnd && p.range.``end``.character >= info.keyStart ->
                                [ "INJECT"
                                  "REPLACE"
                                  "TRY_INJECT"
                                  "TRY_REPLACE"
                                  "INJECT_OR_CREATE"
                                  "REPLACE_OR_CREATE" ]
                                |> List.filter (fun mode -> not (String.Equals(mode, info.mode, StringComparison.OrdinalIgnoreCase)))
                                |> List.map (fun mode ->
                                    { title = $"Change definition injection mode to %s{mode}"
                                      command = "cwtools.definitionInjection.changeMode"
                                      arguments =
                                        [ JsonValue.String(p.textDocument.uri.ToString())
                                          JsonValue.Number(decimal info.line)
                                          JsonValue.String mode ] })
                            | _ -> []

                        match shaderActions with
                        | Some actions -> actions
                        | None ->
                            match les with
                            | [] -> ces @ definitionInjectionModeActions
                            | _ ->
                                ces
                                @ definitionInjectionModeActions
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
                let! cancellationToken = Async.CancellationToken
                cancellationToken.ThrowIfCancellationRequested()
                return
                    match gameObj with
                    | Some game ->
                        let filePath = FileInfo(p.textDocument.uri.LocalPath).FullName
                        let readFileText () =
                            match docs.GetTextByPath(filePath) with
                            | Some t -> t
                            | None -> try System.IO.File.ReadAllText(filePath) with _ -> ""
                        let buildLenses fileText =
                            cancellationToken.ThrowIfCancellationRequested()
                            let hash = contentHash fileText
                            let lenses =
                                getTypesForFile cancellationToken game filePath
                                |> List.map (fun (typeName, id, tdi) -> makeTypeCodeLens (Some fileText) typeName id filePath tdi)
                            cancellationToken.ThrowIfCancellationRequested()
                            cachePut codeLensCache filePath (hash, lenses)
                            evictIfNeeded codeLensCache
                            lenses
                        match codeLensCache.TryGetValue(filePath) with
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
                                            [ JsonValue.String(filePathToUri(filePath).ToString())
                                              codeLensPositionJson line character
                                              JsonValue.String typeName
                                              JsonValue.String id ] } }
                        with _ -> p
                    | None -> p
            }
            |> catchError p

        member this.InlayHint(p: InlayHintParams) =
            let shaderFilePath = FileInfo(p.textDocument.uri.LocalPath).FullName
            if PdxShaderFeatures.isShaderFile shaderFilePath then
                async {
                    if not showInlineText then return []
                    else
                        let shaderText =
                            docs.GetTextByPath(shaderFilePath)
                            |> Option.defaultValue (try File.ReadAllText(shaderFilePath) with _ -> "")
                        let positionAtOffset offset =
                            let bounded = max 0 (min shaderText.Length offset)
                            let mutable line = 0
                            let mutable column = 0
                            for index = 0 to bounded - 1 do
                                if shaderText.[index] = '\n' then
                                    line <- line + 1
                                    column <- 0
                                else
                                    column <- column + 1
                            { line = line; character = column }
                        return
                            PdxShaderFeatures.inlayHints shaderFilePath shaderText
                            |> List.map (fun hint ->
                                { position = positionAtOffset hint.offset
                                  label = hint.label
                                  paddingLeft = true
                                  paddingRight = false })
                            |> List.filter (fun hint ->
                                (hint.position.line > p.range.start.line
                                 || (hint.position.line = p.range.start.line && hint.position.character >= p.range.start.character))
                                && (hint.position.line < p.range.``end``.line
                                    || (hint.position.line = p.range.``end``.line && hint.position.character <= p.range.``end``.character)))
                }
                |> catchError []
            else async {
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
                            // Parse the live editor text directly: the game entity AST lags
                            // behind edits until the debounced lint runs game.UpdateFile, so
                            // its positions go stale whenever an edit changes line counts.
                            match CKParser.parseString fileText filePath with
                            | Failure _ -> None
                            | Success(statements, _, _) ->
                                let rootNode =
                                    CWTools.Process.STLProcess.simpleProcess.ProcessNode () "root" (mkZeroFile filePath) statements
                                let locMap = getOrBuildLocMap game |> Map.ofList
                                let hints = ResizeArray<InlayHint>()
                                let targetPath = filePath
                                let typeDefsByName =
                                    game.TypeDefs()
                                    |> Seq.map (fun td -> td.name, td)
                                    |> Map.ofSeq
                                let typeInfosForFile =
                                    game.Types()
                                    |> Map.toSeq
                                    |> Seq.collect (fun (typeName, infos) ->
                                        infos
                                        |> Seq.choose (fun tdi ->
                                            if String.Equals(tdi.range.FileName, targetPath, pathComparison) then
                                                Some(typeName, tdi)
                                            else
                                                None))
                                    |> Seq.toArray
        
                                // Build scripted variable lookup map
                                let globalVars = game.ScriptedVariables()
                                let fileContent = fileText
                                let localVarPattern = inlayLocalVarPattern
                                let localVars =
                                    [ for m in localVarPattern.Matches(fileContent) ->
                                        m.Groups.[1].Value.Trim(), m.Groups.[2].Value.Trim() ]
                                let varMap = (localVars @ globalVars) |> Map.ofList
                                // One DataTable per inlay-hint request; created once, not per leaf.
                                let inlayHintDataTable = new System.Data.DataTable()

                                let tryFindLocText key =
                                    Map.tryFind key locMap |> Option.map (fun entry -> entry.desc)
                                let tryFindVarText key = Map.tryFind key varMap

                                let trimLocKey (value: string) =
                                    value.Trim().Trim('"')

                                let withUppercaseModifierFallback (candidates: string list) =
                                    candidates
                                    |> List.collect (fun candidate ->
                                        let candidate = trimLocKey candidate
                                        if String.IsNullOrWhiteSpace candidate then
                                            []
                                        elif candidate.StartsWith("mod_", StringComparison.OrdinalIgnoreCase) then
                                            let upperCandidate = candidate.ToUpperInvariant()
                                            if String.Equals(candidate, upperCandidate, StringComparison.Ordinal) then
                                                [ candidate ]
                                            else
                                                [ candidate; upperCandidate ]
                                        else
                                            [ candidate ])
                                    |> List.distinct

                                let sameRange (left: CWTools.Utilities.Position.range) (right: CWTools.Utilities.Position.range) =
                                    String.Equals(left.FileName, right.FileName, pathComparison)
                                    && left.StartLine = right.StartLine
                                    && left.StartColumn = right.StartColumn
                                    && left.EndLine = right.EndLine
                                    && left.EndColumn = right.EndColumn

                                let typeLocalisationKeys (typeName: string) (tdi: TypeDefInfo) (key: string) =
                                    typeLocalisationKeysForSymbol typeDefsByName typeName tdi key

                                let nodeLocCandidates (n: CWTools.Process.Node) =
                                    let nodeKey = trimLocKey n.Key
                                    let matchingTypeInfos =
                                        typeInfosForFile
                                        |> Seq.filter (fun (_, tdi) ->
                                            String.Equals(tdi.id, nodeKey, StringComparison.OrdinalIgnoreCase)
                                            && sameRange tdi.range n.Position)
                                        |> Seq.toList
                                    seq {
                                        for typeName, tdi in matchingTypeInfos do
                                            yield nodeKey
                                            yield! typeLocalisationKeys typeName tdi nodeKey
                                    }
                                    |> Seq.filter (String.IsNullOrWhiteSpace >> not)
                                    |> Seq.distinct
                                    |> Seq.toList

                                let modifierLocCandidates (key: string) =
                                    let key = trimLocKey key
                                    let baseCandidates =
                                        if String.IsNullOrWhiteSpace key then []
                                        elif key.StartsWith("mod_", StringComparison.OrdinalIgnoreCase) then [ key ]
                                        else [ "mod_" + key ]
                                    withUppercaseModifierFallback baseCandidates

                                let valueLocCandidates (value: string) =
                                    let value = trimLocKey value
                                    [ yield value
                                      yield! modifierLocCandidates value ]
                                    |> List.filter (String.IsNullOrWhiteSpace >> not)
                                    |> List.distinct
        
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

                                let getKeyEndPos (key: string) (position: CWTools.Utilities.Position.range) =
                                    let lineIndex = max 0 (int position.StartLine - 1)
                                    if lineIndex >= fileLines.Length then
                                        { line = lineIndex; character = int position.StartColumn }
                                    else
                                        let lineText = fileLines.[lineIndex]
                                        let startColumn = min (max 0 (int position.StartColumn)) lineText.Length
                                        let rawKey = trimLocKey key
                                        let candidates =
                                            [ rawKey
                                              "\"" + rawKey + "\"" ]
                                            |> List.filter (String.IsNullOrWhiteSpace >> not)
                                        let found =
                                            candidates
                                            |> List.choose (fun candidate ->
                                                let index = lineText.IndexOf(candidate, startColumn, StringComparison.Ordinal)
                                                if index >= 0 then Some(index, candidate.Length) else None)
                                            |> List.sortBy fst
                                            |> List.tryHead
                                        match found with
                                        | Some(index, length) -> { line = lineIndex; character = min lineText.Length (index + length) }
                                        | None -> { line = lineIndex; character = min lineText.Length (startColumn + rawKey.Length) }

                                let tryAddLocHintAt (position: LSP.Types.Position) (candidates: string list) =
                                    candidates
                                    |> List.tryPick (fun locKey ->
                                        Map.tryFind locKey locMap
                                        |> Option.bind (fun tr ->
                                            Main.LocalisationPreview.formatHintLabel tryFindLocText tryFindVarText tr.desc
                                            |> Option.map (fun label -> locKey, label)))
                                    |> Option.iter (fun (_, label) ->
                                        hints.Add {
                                            position = position
                                            label = label
                                            paddingLeft = true
                                            paddingRight = true
                                        })

                                let tryAddVarHint (rawVal: string) (position: CWTools.Utilities.Position.range) =
                                    if rawVal.StartsWith("@[") && rawVal.EndsWith("]") then
                                        let expr = rawVal.Substring(2, rawVal.Length - 3)
                                        let mutable finalExpr = expr
                                        let mutable allFound = true
                                        for m in inlayVarNamePattern.Matches(expr) do
                                            let varName = m.Value
                                            let key = if varName.StartsWith("@") then varName else "@" + varName
                                            match Map.tryFind key varMap with
                                            | Some v -> 
                                                // Only replace whole word matches to prevent partial replacements
                                                finalExpr <- replaceWholeWordInlay finalExpr varName v
                                            | None ->
                                                allFound <- false
                                                
                                        if allFound then
                                            try
                                                let result = inlayHintDataTable.Compute(finalExpr, null)
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

                                let tryAddDefinitionInjectionHint (n: CWTools.Process.Node) =
                                    if n.Position.FileName = targetPath then
                                        let line = int n.Position.StartLine - 1
                                        match tryDefinitionInjectionKeyAtLine fileText line with
                                        | Some info when String.Equals(n.Key, info.mode + ":" + info.target, StringComparison.OrdinalIgnoreCase) ->
                                            let label =
                                                match tryFindDefinitionInjectionTarget game info.target with
                                                | Some(typeName, _) -> sprintf "=> %s" typeName
                                                | None -> "=> target not found"

                                            hints.Add {
                                                position = { line = line; character = info.keyEnd }
                                                label = label
                                                paddingLeft = true
                                                paddingRight = true
                                            }
                                        | _ -> ()
        
                                let rec visitNode (n: CWTools.Process.Node) =
                                    if n.Position.FileName = targetPath then
                                        tryAddDefinitionInjectionHint n
                                        tryAddLocHintAt (getKeyEndPos n.Key n.Position) (nodeLocCandidates n)
                                    n.Leaves |> Seq.iter (fun l ->
                                        if l.Position.FileName = targetPath then
                                            tryAddLocHintAt (getKeyEndPos l.Key l.Position) (modifierLocCandidates l.Key)
                                            let rawVal = l.Value.ToRawString().Trim('\"')
                                            // Localization hint
                                            let range = convRangeToLSPRange l.Position
                                            tryAddLocHintAt (getRealEndPos range.start range.``end``) (valueLocCandidates rawVal)
                                            // Scripted variable hint
                                            tryAddVarHint rawVal l.Position
                                    )
                                    n.LeafValues |> Seq.iter (fun lv ->
                                        if lv.Position.FileName = targetPath then
                                            let rawVal = lv.Value.ToRawString().Trim('\"')
                                            let range = convRangeToLSPRange lv.Position
                                            tryAddLocHintAt (getRealEndPos range.start range.``end``) (valueLocCandidates rawVal)
                                            tryAddVarHint rawVal lv.Position
                                    )
                                    n.Nodes |> Seq.iter visitNode
        
                                visitNode rootNode

                                hints
                                |> Seq.distinctBy (fun h -> h.position.line, h.position.character, h.label)
                                |> Seq.toList
                                |> Some
                            
                        let visitor = 
                            { new IGameVisitor<_> with 
                                member this.Visit game = inlayHintFunction game 
                            }
                        
                        match gameDispatcher.Dispatch visitor |> Option.flatten with
                        | Some generatedHints ->
                            cachePut inlayHintCache filePath (hash, generatedHints)
                            evictIfNeeded inlayHintCache
                            return generatedHints
                        | None ->
                            // Parse failed (typically mid-edit unbalanced braces). Returning
                            // old hints here makes their old positions attach to the new text.
                            cachePut inlayHintCache filePath (hash, [])
                            evictIfNeeded inlayHintCache
                            return []
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
                                  target = Some(filePathToUri(link.targetFilepath)) })
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
                                        target = Some (filePathToUri(fullPath))
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
                let! cancellationToken = Async.CancellationToken

                let semanticTokensFunction (game: IGame<_>) =
                    cancellationToken.ThrowIfCancellationRequested()
                    // - Content-hash cache: skip full AST traversal if file unchanged -
                    let filePath = p.textDocument.uri.LocalPath
                    let fileInfo = FileInfo(filePath)
                    let fileText, documentVersion =
                        match docs.Get(fileInfo) with
                        | Some(text, version) -> text, Some version
                        | None ->
                            let diskText =
                                try File.ReadAllText fileInfo.FullName
                                with _ -> ""
                            diskText, None

                    let documentStillCurrent () = docs.GetVersion(fileInfo) = documentVersion
                    let hash = contentHash fileText
                    match semanticTokensCache.TryGetValue(filePath) with
                    | true, (_, cachedHash, cachedData, cachedResultId) when cachedHash = hash && documentStillCurrent () ->
                        cachePut semanticTokensCache filePath (documentVersion, cachedHash, cachedData, cachedResultId)
                        Some { data = Array.toList cachedData; resultId = Some cachedResultId }
                    | _ when
                        not (PdxShaderFeatures.isShaderFile filePath)
                        && isCompletionHeavyEditPath filePath
                        && isCompletionHeavyInteractiveWindow () ->
                        None
                    | _ ->
                        let allEffects, allTriggers = getSemanticClassificationNames cancellationToken game
                        let dataArray =
                            computeTokensForFile cancellationToken game allEffects allTriggers filePath fileText
                        cancellationToken.ThrowIfCancellationRequested()

                        if not (documentStillCurrent ()) then
                            None
                        else
                            let resultId = Guid.NewGuid().ToString()
                            cachePut semanticTokensCache filePath (documentVersion, hash, dataArray, resultId)
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
                let! cancellationToken = Async.CancellationToken

                let semanticTokensFullDeltaFunction (game: IGame<_>) =
                    cancellationToken.ThrowIfCancellationRequested()
                    let filePath = p.textDocument.uri.LocalPath
                    let fileInfo = FileInfo(filePath)
                    let fileText, documentVersion =
                        match docs.Get(fileInfo) with
                        | Some(text, version) -> text, Some version
                        | None ->
                            let diskText =
                                try File.ReadAllText fileInfo.FullName
                                with _ -> ""
                            diskText, None

                    let documentStillCurrent () = docs.GetVersion(fileInfo) = documentVersion
                    let hash = contentHash fileText
                    match semanticTokensCache.TryGetValue(filePath) with
                    | true, (_, cachedHash, cachedData, cachedResultId) when cachedHash = hash && documentStillCurrent () ->
                        cachePut semanticTokensCache filePath (documentVersion, cachedHash, cachedData, cachedResultId)
                        if p.previousResultId = cachedResultId then
                            Some(Choice2Of2 { resultId = cachedResultId; edits = [] })
                        else
                            Some(Choice1Of2 { data = Array.toList cachedData; resultId = Some cachedResultId })
                    | true, _ when not (PdxShaderFeatures.isShaderFile filePath) && isCompletionHeavyEditPath filePath ->
                        // Dynamic definition files are completion-heavy. After each
                        // accepted suggestion, VS Code immediately asks for semantic
                        // token deltas; recomputing them walks the old game AST and
                        // can delay the next completion. Cancel and let VS Code shift
                        // existing tokens until the next stable full refresh.
                        None
                    | _ when
                        not (PdxShaderFeatures.isShaderFile filePath)
                        && isCompletionHeavyEditPath filePath
                        && isCompletionHeavyInteractiveWindow () ->
                        None
                    | true, (_, _, oldDataArray, oldResultId) ->
                        let allEffects, allTriggers = getSemanticClassificationNames cancellationToken game
                        let newDataArray =
                            computeTokensForFile cancellationToken game allEffects allTriggers filePath fileText
                        cancellationToken.ThrowIfCancellationRequested()

                        if not (documentStillCurrent ()) then None
                        else
                            let newResultId = Guid.NewGuid().ToString()
                            cachePut semanticTokensCache filePath (documentVersion, hash, newDataArray, newResultId)
                            evictIfNeeded semanticTokensCache
                            if p.previousResultId = oldResultId then
                                let edit = computeDelta oldDataArray newDataArray
                                Some(Choice2Of2 { resultId = newResultId; edits = [ edit ] })
                            else
                                Some(Choice1Of2 { data = Array.toList newDataArray; resultId = Some newResultId })
                    | _ ->
                        let allEffects, allTriggers = getSemanticClassificationNames cancellationToken game
                        let newDataArray =
                            computeTokensForFile cancellationToken game allEffects allTriggers filePath fileText
                        cancellationToken.ThrowIfCancellationRequested()

                        if not (documentStillCurrent ()) then None
                        else
                            let newResultId = Guid.NewGuid().ToString()
                            cachePut semanticTokensCache filePath (documentVersion, hash, newDataArray, newResultId)
                            evictIfNeeded semanticTokensCache
                            Some(Choice1Of2 { data = Array.toList newDataArray; resultId = Some newResultId })
                let visitor =
                    { new IGameVisitor<_> with
                        member this.Visit game = semanticTokensFullDeltaFunction game }
                return
                    gameDispatcher.Dispatch visitor
                    |> Option.flatten
            }
            |> catchError None

        member this.FoldingRanges(p: FoldingRangeParams) =
            async {
                let filePath = getPathFromDoc p.textDocument.uri
                let fileText = docs.GetText(FileInfo(filePath)) |> Option.defaultValue ""
                if PdxShaderFeatures.isShaderFile filePath then
                    return
                        PdxShaderFeatures.foldingRanges filePath fileText
                        |> List.map (fun shaderRange ->
                            { startLine = max 0 (int shaderRange.StartLine - 1)
                              startCharacter = Some(int shaderRange.StartColumn)
                              endLine = max 0 (int shaderRange.EndLine - 1)
                              endCharacter = Some(int shaderRange.EndColumn)
                              kind = Some "region" })
                        |> List.distinctBy (fun item -> item.startLine, item.startCharacter, item.endLine, item.endCharacter)
                        |> List.sortBy (fun item -> item.startLine, item.startCharacter, item.endLine, item.endCharacter)
                else
                    return
                        Main.PdxFolding.ranges fileText
                        |> List.map (fun span ->
                            { startLine = span.startLine
                              startCharacter = Some span.startCharacter
                              endLine = span.endLine
                              endCharacter = span.endCharacter
                              kind = None })
            }
            |> catchError []

        member this.SelectionRanges(p: SelectionRangeParams) =
            async {
                let filePath = getPathFromDoc p.textDocument.uri
                let fileText = docs.GetText(FileInfo(filePath)) |> Option.defaultValue ""
                let rec toSelectionRange ranges =
                    match ranges with
                    | [] -> None
                    | shaderRange :: rest ->
                        Some
                            { range = convRangeToLSPRange shaderRange
                              parent = toSelectionRange rest }
                return
                    p.positions
                    |> List.map (fun position ->
                        if PdxShaderFeatures.isShaderFile filePath then
                            PdxShaderFeatures.selectionRangesAt
                                (PosHelper.fromZ position.line position.character)
                                filePath
                                fileText
                            |> toSelectionRange
                            |> Option.defaultValue
                                { range = { start = position; ``end`` = position }
                                  parent = None }
                        else
                            { range = { start = position; ``end`` = position }
                              parent = None })
            }
            |> catchError []

        member this.PrepareCallHierarchy(p: TextDocumentPositionParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let filePath = getPathFromDoc p.textDocument.uri
                        if not (PdxShaderFeatures.isShaderFile filePath) then []
                        else
                            let fileText = docs.GetText(FileInfo(filePath)) |> Option.defaultValue ""
                            let cursor = PosHelper.fromZ p.position.line p.position.character
                            let targetName =
                                PdxShaderFeatures.renameTargetAt (game.AllFiles()) cursor filePath fileText
                                |> Option.map _.name
                            let openDocuments =
                                docs.OpenFiles()
                                |> List.choose (fun file ->
                                    if PdxShaderFeatures.isShaderFile file.FullName
                                       || PdxShaderRuntime.isEvidenceScriptFile file.FullName then
                                        docs.GetText file |> Option.map (fun text -> file.FullName, text)
                                    else None)
                            let model =
                                PdxShaderRuntime.buildModel
                                    (if activeGame = STL then stlGameVersion else None)
                                    (game.AllFiles())
                                    openDocuments
                            model.declarations
                            |> List.filter (fun declaration ->
                                match declaration.kind with
                                | PdxShaderRuntime.EffectDeclaration
                                | PdxShaderRuntime.VertexMainCodeDeclaration
                                | PdxShaderRuntime.PixelMainCodeDeclaration
                                | PdxShaderRuntime.GeometryMainCodeDeclaration
                                | PdxShaderRuntime.HlslFunctionDeclaration ->
                                    rangeContainsPos declaration.selectionRange cursor
                                    || targetName |> Option.exists (fun name -> declaration.name.Equals(name, StringComparison.OrdinalIgnoreCase))
                                | _ -> false)
                            |> List.map (fun declaration ->
                                { name = declaration.name
                                  kind = 12
                                  detail =
                                    Some(
                                        if declaration.kind = PdxShaderRuntime.EffectDeclaration then "Paradox Shader runtime Effect"
                                        else "Paradox Shader HLSL/compile-unit call")
                                  uri = filePathToUri(declaration.file)
                                  range = convRangeToLSPRange declaration.range
                                  selectionRange = convRangeToLSPRange declaration.selectionRange
                                  data =
                                    Some(
                                        JsonValue.Record
                                            [| "domain", JsonValue.String "shader_declaration"
                                               "stableId", JsonValue.String declaration.stableId |]) })
                            |> List.distinctBy (fun item -> item.uri, item.selectionRange.start.line, item.selectionRange.start.character, item.name)
                    | None -> []
            }
            |> catchError []

        member this.CallHierarchyIncomingCalls(p: CallHierarchyIncomingCallsParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let stringData name =
                            p.item.data
                            |> Option.bind (function
                                | JsonValue.Record fields ->
                                    fields
                                    |> Array.tryPick (fun (key, value) ->
                                        if key = name then
                                            match value with JsonValue.String text -> Some text | _ -> None
                                        else None)
                                | _ -> None)
                        match stringData "stableId", stringData "domain" with
                        | Some stableId, Some "runtime_call" -> []
                        | Some stableId, _ ->
                            let openDocuments =
                                docs.OpenFiles()
                                |> List.choose (fun file ->
                                    if PdxShaderFeatures.isShaderFile file.FullName
                                       || PdxShaderRuntime.isEvidenceScriptFile file.FullName then
                                        docs.GetText file |> Option.map (fun text -> file.FullName, text)
                                    else None)
                            let model =
                                PdxShaderRuntime.buildModel
                                    (if activeGame = STL then stlGameVersion else None)
                                    (game.AllFiles())
                                    openDocuments
                            let declarationItem (declaration: PdxShaderRuntime.ShaderDeclaration) : CallHierarchyItem =
                                { name = declaration.name
                                  kind = 12
                                  detail = Some "Paradox Shader semantic call"
                                  uri = filePathToUri(declaration.file)
                                  range = convRangeToLSPRange declaration.range
                                  selectionRange = convRangeToLSPRange declaration.selectionRange
                                  data =
                                    Some(
                                        JsonValue.Record
                                            [| "domain", JsonValue.String "shader_declaration"
                                               "stableId", JsonValue.String declaration.stableId |]) }
                            let semanticCalls =
                                model.semanticReferences
                                |> List.filter (fun reference -> reference.targetIds |> List.contains stableId)
                                |> List.choose (fun reference ->
                                    reference.sourceId
                                    |> Option.bind (fun sourceId -> model.declarations |> List.tryFind (fun declaration -> declaration.stableId = sourceId))
                                    |> Option.map (fun source ->
                                        { ``from`` = declarationItem source
                                          fromRanges = [ convRangeToLSPRange reference.span ] }))
                            let runtimeCalls =
                                model.effects
                                |> List.tryFind (fun effect -> effect.declaration.stableId = stableId)
                                |> Option.map _.allEvidence
                                |> Option.defaultValue []
                                |> List.map (fun evidence ->
                                    let callerName =
                                        evidence.interfaceSprite
                                        |> Option.orElse evidence.enclosingBlock
                                        |> Option.defaultValue (Path.GetFileName(evidence.sourceFile))
                                    { ``from`` =
                                        { name = callerName
                                          kind = 12
                                          detail = Some(sprintf "Shader runtime call (%A)" evidence.kind)
                                          uri = filePathToUri(evidence.sourceFile)
                                          range = convRangeToLSPRange evidence.span
                                          selectionRange = convRangeToLSPRange evidence.span
                                          data =
                                            Some(
                                                JsonValue.Record
                                                    [| "domain", JsonValue.String "runtime_call"
                                                       "stableId", JsonValue.String stableId |]) }
                                      fromRanges = [ convRangeToLSPRange evidence.span ] })
                            semanticCalls @ runtimeCalls
                            |> List.sortBy (fun call -> call.``from``.uri.LocalPath, call.``from``.selectionRange.start.line, call.``from``.selectionRange.start.character)
                        | _ -> []
                    | None -> []
            }
            |> catchError []

        member this.CallHierarchyOutgoingCalls(p: CallHierarchyOutgoingCallsParams) =
            async {
                return
                    match gameObj with
                    | Some game ->
                        let stringData name =
                            p.item.data
                            |> Option.bind (function
                                | JsonValue.Record fields ->
                                    fields
                                    |> Array.tryPick (fun (key, value) ->
                                        if key = name then
                                            match value with JsonValue.String text -> Some text | _ -> None
                                        else None)
                                | _ -> None)
                        match stringData "stableId" with
                        | None -> []
                        | Some stableId ->
                            let openDocuments =
                                docs.OpenFiles()
                                |> List.choose (fun file ->
                                    if PdxShaderFeatures.isShaderFile file.FullName
                                       || PdxShaderRuntime.isEvidenceScriptFile file.FullName then
                                        docs.GetText file |> Option.map (fun text -> file.FullName, text)
                                    else None)
                            let model =
                                PdxShaderRuntime.buildModel
                                    (if activeGame = STL then stlGameVersion else None)
                                    (game.AllFiles())
                                    openDocuments
                            let declarationItem (declaration: PdxShaderRuntime.ShaderDeclaration) : CallHierarchyItem =
                                { name = declaration.name
                                  kind = 12
                                  detail = Some "Paradox Shader semantic call"
                                  uri = filePathToUri(declaration.file)
                                  range = convRangeToLSPRange declaration.range
                                  selectionRange = convRangeToLSPRange declaration.selectionRange
                                  data =
                                    Some(
                                        JsonValue.Record
                                            [| "domain", JsonValue.String "shader_declaration"
                                               "stableId", JsonValue.String declaration.stableId |]) }
                            if stringData "domain" = Some "runtime_call" then
                                model.declarations
                                |> List.filter (fun declaration -> declaration.stableId = stableId)
                                |> List.map (fun declaration ->
                                    { ``to`` = declarationItem declaration
                                      fromRanges = [ p.item.selectionRange ] })
                            else
                                model.semanticReferences
                                |> List.filter (fun reference -> reference.sourceId = Some stableId)
                                |> List.collect (fun reference ->
                                    let exactTargets =
                                        model.declarations
                                        |> List.filter (fun declaration -> reference.targetIds |> List.contains declaration.stableId)
                                    let targets =
                                        if not exactTargets.IsEmpty then exactTargets
                                        else model.declarations |> List.filter (fun declaration -> declaration.name.Equals(reference.targetName, StringComparison.OrdinalIgnoreCase))
                                    targets
                                    |> List.map (fun target ->
                                        { ``to`` = declarationItem target
                                          fromRanges = [ convRangeToLSPRange reference.span ] }))
                                |> List.sortBy (fun call -> call.``to``.uri.LocalPath, call.``to``.selectionRange.start.line, call.``to``.selectionRange.start.character)
                    | None -> []
            }
            |> catchError []

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
                    let extension = Path.GetExtension(path.AsSpan())

                    if extension.Equals(".yml", StringComparison.OrdinalIgnoreCase) then
                        match formatLocalisationYaml p.options fileText with
                        | Some formatted ->
                            return
                                [ { range = createRange 0 0 100000 0
                                    newText = formatted } ]
                        | None -> return []
                    elif PdxShaderFeatures.isShaderFile path then
                        let formatted =
                            PdxShaderFeatures.formatDocument
                                p.options.insertSpaces
                                p.options.tabSize
                                path
                                fileText
                        if String.Equals(formatted, fileText, StringComparison.Ordinal) then return []
                        else
                            return
                                [ { range = createRange 0 0 100000 0
                                    newText = formatted } ]
                    elif extension.Equals(".gui", StringComparison.OrdinalIgnoreCase) then
                        return []
                    else
                        match CKParser.parseString fileText path with
                        | Success(sl, _, _) ->
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

        member this.PrepareRename(p: TextDocumentPositionParams) =
            let sameFile left right =
                String.Equals(left, right, pathComparison)

            let isSymbolBoundaryChar (c: char) =
                Char.IsLetterOrDigit c
                || c = '_'
                || c = '$'
                || c = ':'
                || c = '@'
                || c = '-'
                || c = '/'

            let isDottedCandidateChar (c: char) =
                isSymbolBoundaryChar c || c = '.'

            let readDocumentText filePath =
                docs.GetText(FileInfo(filePath))
                |> Option.defaultValue (try File.ReadAllText filePath with _ -> "")

            let tryGetSingleLineTextInRange (text: string) (target: range) =
                let lines = text.Split('\n')
                let startLine = int target.StartLine - 1
                let endLine = int target.EndLine - 1
                if startLine <> endLine || startLine < 0 || startLine >= lines.Length then None
                else
                    let line = lines.[startLine].TrimEnd('\r')
                    let startColumn = int target.StartColumn |> max 0 |> min line.Length
                    let endColumn = int target.EndColumn |> max startColumn |> min line.Length
                    Some(line.Substring(startColumn, endColumn - startColumn))

            let tryFindDottedCandidateRangeAtPosition filePath (text: string) (position: pos) =
                let lines = text.Split('\n')
                let lineIndex = int position.Line - 1
                if lineIndex < 0 || lineIndex >= lines.Length then None
                else
                    let line = lines.[lineIndex].TrimEnd('\r')
                    let column = position.Column |> int |> max 0 |> min line.Length

                    let seedIndex =
                        if column < line.Length && isDottedCandidateChar line.[column] then Some column
                        elif column > 0 && isDottedCandidateChar line.[column - 1] then Some(column - 1)
                        else None

                    seedIndex
                    |> Option.map (fun index ->
                        let mutable startIndex = index
                        while startIndex > 0 && isDottedCandidateChar line.[startIndex - 1] do
                            startIndex <- startIndex - 1

                        let mutable endIndex = index + 1
                        while endIndex < line.Length && isDottedCandidateChar line.[endIndex] do
                            endIndex <- endIndex + 1

                        mkRange filePath (mkPos (lineIndex + 1) startIndex) (mkPos (lineIndex + 1) endIndex))

            let tryFindIdentifierRangeInRange (text: string) (target: range) (symbol: string) =
                let needle = normalizeDefinitionSymbol symbol
                if String.IsNullOrWhiteSpace needle then None
                else
                    let lines = text.Split('\n')
                    let startLine = max 0 (int target.StartLine - 1)
                    let endLine = min (lines.Length - 1) (max startLine (int target.EndLine - 1))

                    let tryFindOnLine lineIndex =
                        if lineIndex < 0 || lineIndex >= lines.Length then None
                        else
                            let line = lines.[lineIndex].TrimEnd('\r')
                            let minColumn = if lineIndex = startLine then int target.StartColumn |> max 0 |> min line.Length else 0
                            let maxColumn = if lineIndex = endLine then int target.EndColumn |> max minColumn |> min line.Length else line.Length

                            let rec loop startIndex =
                                let index = line.IndexOf(needle, startIndex, StringComparison.Ordinal)
                                if index < 0 || index + needle.Length > maxColumn then None
                                elif index < minColumn then loop (index + 1)
                                else
                                    let beforeOk = index = 0 || not (isSymbolBoundaryChar line.[index - 1])
                                    let afterIndex = index + needle.Length
                                    let afterOk = afterIndex >= line.Length || not (isSymbolBoundaryChar line.[afterIndex])
                                    if beforeOk && afterOk then
                                        Some(mkRange target.FileName (mkPos (lineIndex + 1) index) (mkPos (lineIndex + 1) afterIndex))
                                    else
                                        loop (index + 1)

                            loop minColumn

                    if startLine > endLine then None
                    else [ startLine .. endLine ] |> List.tryPick tryFindOnLine

            let allTypeDefinitions (game: IGame) =
                game.Types()
                |> Map.toSeq
                |> Seq.collect (fun (typeName, infos) -> infos |> Seq.map (fun tdi -> typeName, tdi))

            let tryTypeDefinitionAtPosition (game: IGame) filePath text position =
                allTypeDefinitions game
                |> Seq.tryFind (fun (_, tdi) ->
                    sameFile tdi.range.FileName filePath
                    && (tryFindIdentifierRangeInRange text tdi.range tdi.id
                        |> Option.exists (fun identifierRange -> rangeContainsPos identifierRange position)))

            let tryTypeDefinitionForRange (game: IGame) (target: range) =
                allTypeDefinitions game
                |> Seq.tryFind (fun (_, tdi) ->
                    sameFile tdi.range.FileName target.FileName
                    && (rangeContainsRange tdi.range target || rangeContainsRange target tdi.range))

            let shaderPrepareResult =
                match gameObj with
                | Some game ->
                    let path = getPathFromDoc p.textDocument.uri
                    if not (PdxShaderFeatures.isShaderFile path) then None
                    else
                        let text = readDocumentText path
                        let target =
                            PdxShaderFeatures.renameTargetAt
                                (game.AllFiles())
                                (PosHelper.fromZ p.position.line p.position.character)
                                path
                                text
                        let allowedTarget =
                            target
                            |> Option.filter (fun value ->
                                if not (value.kind.Equals("effect", StringComparison.OrdinalIgnoreCase)) then true
                                else
                                    let openDocuments =
                                        docs.OpenFiles()
                                        |> List.choose (fun file ->
                                            if PdxShaderFeatures.isShaderFile file.FullName
                                               || PdxShaderRuntime.isEvidenceScriptFile file.FullName then
                                                docs.GetText file |> Option.map (fun contents -> file.FullName, contents)
                                            else None)
                                    let model =
                                        PdxShaderRuntime.buildModel
                                            (if activeGame = STL then stlGameVersion else None)
                                            (game.AllFiles())
                                            openDocuments
                                    match PdxShaderRuntime.renamePolicy model value.name with
                                    | PdxShaderRuntime.RenameAllowed _ -> true
                                    | PdxShaderRuntime.RenameRequiresExplicitForce _
                                    | PdxShaderRuntime.RenameDenied _ -> false)
                        Some(
                            allowedTarget
                            |> Option.map (fun target ->
                                { range = convRangeToLSPRange target.range
                                  placeholder = target.name }))
                | None -> None

            async {
                return
                    match shaderPrepareResult, gameObj with
                    | Some result, _ -> result
                    | None, Some game ->
                        let position = PosHelper.fromZ p.position.line p.position.character
                        let path = getPathFromDoc p.textDocument.uri
                        let sourceText = readDocumentText path

                        let lineRange =
                            let lines = sourceText.Split('\n')
                            let lineIndex = int position.Line - 1
                            if lineIndex < 0 || lineIndex >= lines.Length then None
                            else
                                let line = lines.[lineIndex].TrimEnd('\r')
                                Some(mkRange path (mkPos (lineIndex + 1) 0) (mkPos (lineIndex + 1) line.Length))

                        let typeInfoAtCursor = tryTypeDefinitionAtPosition game path sourceText position

                        let typeInfoFromDefinition =
                            match typeInfoAtCursor with
                            | Some _ -> None
                            | None ->
                                game.GoToType position path sourceText
                                |> preferCodeDefinitionOverLocalisation
                                    gameDispatcher
                                    game
                                    path
                                    sourceText
                                    p.position.line
                                    p.position.character
                                |> Option.bind (tryTypeDefinitionForRange game)

                        let semanticRange =
                            typeInfoAtCursor
                            |> Option.orElse typeInfoFromDefinition
                            |> Option.bind (fun (_, tdi) ->
                                lineRange |> Option.bind (fun r -> tryFindIdentifierRangeInRange sourceText r tdi.id))

                        let textRange =
                            semanticRange
                            |> Option.orElseWith (fun () -> tryFindDottedCandidateRangeAtPosition path sourceText position)

                        textRange
                        |> Option.bind (fun r ->
                            tryGetSingleLineTextInRange sourceText r
                            |> Option.map (fun placeholder ->
                                { range = convRangeToLSPRange r
                                  placeholder = placeholder }))
                    | None, None -> None
            }
            |> catchError None

        member this.Rename(p: RenameParams) =
            let sameFile left right =
                String.Equals(left, right, pathComparison)

            let sameRange (left: range) (right: range) =
                sameFile left.FileName right.FileName
                && left.StartLine = right.StartLine
                && left.StartColumn = right.StartColumn
                && left.EndLine = right.EndLine
                && left.EndColumn = right.EndColumn

            let rangeKey (r: range) =
                (r.FileName.ToLowerInvariant(), r.StartLine, r.StartColumn, r.EndLine, r.EndColumn)

            let isIdentifierChar (c: char) =
                Char.IsLetterOrDigit c
                || c = '_'
                || c = '$'
                || c = ':'
                || c = '@'
                || c = '-'
                || c = '/'

            let isDottedCandidateChar (c: char) =
                isIdentifierChar c || c = '.'

            let readDocumentText filePath =
                docs.GetText(FileInfo(filePath))
                |> Option.defaultValue (try File.ReadAllText filePath with _ -> "")

            let tryFindIdentifierRangeInDefinition (definitionRange: range) (symbol: string) =
                let needle = normalizeDefinitionSymbol symbol
                if String.IsNullOrWhiteSpace needle then None
                else
                    let text = readDocumentText definitionRange.FileName
                    let lines = text.Split('\n')
                    let startLine = max 0 (int definitionRange.StartLine - 1)
                    let rangeEndLine = max startLine (int definitionRange.EndLine - 1)
                    let endLine = min (lines.Length - 1) (min rangeEndLine (startLine + 120))

                    let tryFindOnLine lineIndex =
                        if lineIndex < 0 || lineIndex >= lines.Length then None
                        else
                            let line = lines.[lineIndex].TrimEnd('\r')

                            let rec loop startIndex =
                                let index = line.IndexOf(needle, startIndex, StringComparison.Ordinal)
                                if index < 0 then None
                                else
                                    let beforeOk = index = 0 || not (isIdentifierChar line.[index - 1])
                                    let afterIndex = index + needle.Length
                                    let afterOk = afterIndex >= line.Length || not (isIdentifierChar line.[afterIndex])
                                    if beforeOk && afterOk then
                                        Some(mkRange definitionRange.FileName (mkPos (lineIndex + 1) index) (mkPos (lineIndex + 1) afterIndex))
                                    else
                                        loop (index + 1)

                            loop 0

                    if startLine > endLine then None
                    else [ startLine .. endLine ] |> List.tryPick tryFindOnLine

            let tryFindIdentifierRangeAtPosition filePath (text: string) (position: pos) =
                let lines = text.Split('\n')
                let lineIndex = int position.Line - 1
                if lineIndex < 0 || lineIndex >= lines.Length then None
                else
                    let line = lines.[lineIndex].TrimEnd('\r')
                    let column = position.Column |> int |> max 0 |> min line.Length

                    let seedIndex =
                        if column < line.Length && isIdentifierChar line.[column] then Some column
                        elif column > 0 && isIdentifierChar line.[column - 1] then Some(column - 1)
                        else None

                    seedIndex
                    |> Option.map (fun index ->
                        let mutable startIndex = index
                        while startIndex > 0 && isIdentifierChar line.[startIndex - 1] do
                            startIndex <- startIndex - 1

                        let mutable endIndex = index + 1
                        while endIndex < line.Length && isIdentifierChar line.[endIndex] do
                            endIndex <- endIndex + 1

                        mkRange filePath (mkPos (lineIndex + 1) startIndex) (mkPos (lineIndex + 1) endIndex))

            let tryFindDottedCandidateRangeAtPosition filePath (text: string) (position: pos) =
                let lines = text.Split('\n')
                let lineIndex = int position.Line - 1
                if lineIndex < 0 || lineIndex >= lines.Length then None
                else
                    let line = lines.[lineIndex].TrimEnd('\r')
                    let column = position.Column |> int |> max 0 |> min line.Length

                    let seedIndex =
                        if column < line.Length && isDottedCandidateChar line.[column] then Some column
                        elif column > 0 && isDottedCandidateChar line.[column - 1] then Some(column - 1)
                        else None

                    seedIndex
                    |> Option.map (fun index ->
                        let mutable startIndex = index
                        while startIndex > 0 && isDottedCandidateChar line.[startIndex - 1] do
                            startIndex <- startIndex - 1

                        let mutable endIndex = index + 1
                        while endIndex < line.Length && isDottedCandidateChar line.[endIndex] do
                            endIndex <- endIndex + 1

                        mkRange filePath (mkPos (lineIndex + 1) startIndex) (mkPos (lineIndex + 1) endIndex))

            let tryGetSingleLineTextInRange (target: range) =
                let text = readDocumentText target.FileName
                let lines = text.Split('\n')
                let startLine = int target.StartLine - 1
                let endLine = int target.EndLine - 1
                if startLine <> endLine || startLine < 0 || startLine >= lines.Length then None
                else
                    let line = lines.[startLine].TrimEnd('\r')
                    let startColumn = int target.StartColumn |> max 0 |> min line.Length
                    let endColumn = int target.EndColumn |> max startColumn |> min line.Length
                    Some(line.Substring(startColumn, endColumn - startColumn))

            let tryFindLocalisationKeyRange (entry: Entry) (expectedKey: string) =
                let text = readDocumentText entry.position.FileName
                let lines = text.Split('\n')
                let lineIndex = int entry.position.StartLine - 1

                if lineIndex < 0 || lineIndex >= lines.Length then
                    None
                else
                    let line = lines.[lineIndex].TrimEnd('\r')
                    let entryMatch = localisationEntryPattern.Match(line)

                    if entryMatch.Success
                       && String.Equals(entryMatch.Groups.[2].Value, expectedKey, StringComparison.Ordinal) then
                        let keyGroup = entryMatch.Groups.[2]
                        Some(
                            mkRange
                                entry.position.FileName
                                (mkPos (lineIndex + 1) keyGroup.Index)
                                (mkPos (lineIndex + 1) (keyGroup.Index + keyGroup.Length))
                        )
                    else
                        let minColumn = int entry.position.StartColumn |> max 0 |> min line.Length
                        let maxColumn = int entry.position.EndColumn |> max minColumn |> min line.Length
                        let index = line.IndexOf(expectedKey, minColumn, StringComparison.Ordinal)

                        if index >= 0 && index + expectedKey.Length <= maxColumn then
                            let afterIndex = index + expectedKey.Length
                            let beforeOk = index = 0 || Char.IsWhiteSpace(line.[index - 1])
                            let afterOk = afterIndex < line.Length && line.[afterIndex] = ':'

                            if beforeOk && afterOk then
                                Some(
                                    mkRange
                                        entry.position.FileName
                                        (mkPos (lineIndex + 1) index)
                                        (mkPos (lineIndex + 1) afterIndex)
                                )
                            else
                                None
                        else
                            None

            let tryFindIdentifierRangeInRange (target: range) (symbol: string) =
                let needle = normalizeDefinitionSymbol symbol
                if String.IsNullOrWhiteSpace needle then None
                else
                    let text = readDocumentText target.FileName
                    let lines = text.Split('\n')
                    let startLine = max 0 (int target.StartLine - 1)
                    let endLine = min (lines.Length - 1) (max startLine (int target.EndLine - 1))

                    let tryFindOnLine lineIndex =
                        if lineIndex < 0 || lineIndex >= lines.Length then None
                        else
                            let line = lines.[lineIndex].TrimEnd('\r')
                            let minColumn = if lineIndex = startLine then int target.StartColumn |> max 0 |> min line.Length else 0
                            let maxColumn = if lineIndex = endLine then int target.EndColumn |> max minColumn |> min line.Length else line.Length

                            let rec loop startIndex =
                                let index = line.IndexOf(needle, startIndex, StringComparison.Ordinal)
                                if index < 0 || index + needle.Length > maxColumn then None
                                elif index < minColumn then loop (index + 1)
                                else
                                    let beforeOk = index = 0 || not (isIdentifierChar line.[index - 1])
                                    let afterIndex = index + needle.Length
                                    let afterOk = afterIndex >= line.Length || not (isIdentifierChar line.[afterIndex])
                                    if beforeOk && afterOk then
                                        Some(mkRange target.FileName (mkPos (lineIndex + 1) index) (mkPos (lineIndex + 1) afterIndex))
                                    else
                                        loop (index + 1)

                            loop minColumn

                    if startLine > endLine then None
                    else [ startLine .. endLine ] |> List.tryPick tryFindOnLine

            let allTypeDefinitions (game: IGame) =
                game.Types()
                |> Map.toSeq
                |> Seq.collect (fun (typeName, infos) -> infos |> Seq.map (fun tdi -> typeName, tdi))

            let tryTypeDefinitionAtPosition (game: IGame) filePath position =
                allTypeDefinitions game
                |> Seq.tryFind (fun (_, tdi) ->
                    sameFile tdi.range.FileName filePath
                    && (tryFindIdentifierRangeInDefinition tdi.range tdi.id
                        |> Option.exists (fun identifierRange -> rangeContainsPos identifierRange position)))

            let tryTypeDefinitionForRange (game: IGame) (target: range) =
                allTypeDefinitions game
                |> Seq.tryFind (fun (_, tdi) ->
                    sameFile tdi.range.FileName target.FileName
                    && (sameRange tdi.range target
                        || rangeContainsRange tdi.range target
                        || rangeContainsRange target tdi.range))

            let shaderRenameResult =
                match gameObj with
                | Some game ->
                    let path = getPathFromDoc p.textDocument.uri
                    if not (PdxShaderFeatures.isShaderFile path) then None
                    else
                        let text = readDocumentText path
                        let validNewName =
                            not (String.IsNullOrWhiteSpace p.newName)
                            && System.Text.RegularExpressions.Regex.IsMatch(p.newName, "^[A-Za-z_][A-Za-z0-9_]*$")
                        let target =
                            if not validNewName then None
                            else
                                PdxShaderFeatures.renameTargetAt
                                    (game.AllFiles())
                                    (PosHelper.fromZ p.position.line p.position.character)
                                    path
                                    text
                        let allowedTarget =
                            target
                            |> Option.filter (fun value ->
                                if String.Equals(value.name, p.newName, StringComparison.Ordinal) then false
                                elif not (value.kind.Equals("effect", StringComparison.OrdinalIgnoreCase)) then true
                                else
                                    let openDocuments =
                                        docs.OpenFiles()
                                        |> List.choose (fun file ->
                                            if PdxShaderFeatures.isShaderFile file.FullName
                                               || PdxShaderRuntime.isEvidenceScriptFile file.FullName then
                                                docs.GetText file |> Option.map (fun contents -> file.FullName, contents)
                                            else None)
                                    let model =
                                        PdxShaderRuntime.buildModel
                                            (if activeGame = STL then stlGameVersion else None)
                                            (game.AllFiles())
                                            openDocuments
                                    match PdxShaderRuntime.renamePolicy model value.name with
                                    | PdxShaderRuntime.RenameAllowed _ -> true
                                    | PdxShaderRuntime.RenameRequiresExplicitForce _
                                    | PdxShaderRuntime.RenameDenied _ -> false)
                        let changes =
                            allowedTarget
                            |> Option.map (fun value -> value.edits)
                            |> Option.defaultValue []
                            |> List.distinctBy rangeKey
                            |> List.sortBy rangeKey
                            |> List.groupBy _.FileName
                            |> List.sortBy fst
                            |> List.map (fun (fileName, ranges) ->
                                filePathToUri(fileName).ToString(),
                                (ranges
                                 |> List.map (fun editRange ->
                                     { range = convRangeToLSPRange editRange
                                       newText = p.newName })))
                            |> Map.ofList
                        Some { documentChanges = None; changes = changes }
                | None -> None

            async {
                return
                    match shaderRenameResult, gameObj with
                    | Some result, _ -> result
                    | None, Some game ->
                        let position = PosHelper.fromZ p.position.line p.position.character
                        let path = getPathFromDoc p.textDocument.uri
                        let sourceText = readDocumentText path

                        let typeInfoAtCursor = tryTypeDefinitionAtPosition game path position

                        let typeInfoFromDefinition =
                            match typeInfoAtCursor with
                            | Some _ -> None
                            | None ->
                                game.GoToType position path sourceText
                                |> preferCodeDefinitionOverLocalisation
                                    gameDispatcher
                                    game
                                    path
                                    sourceText
                                    p.position.line
                                    p.position.character
                                |> Option.bind (tryTypeDefinitionForRange game)

                        let typeInfo = typeInfoAtCursor |> Option.orElse typeInfoFromDefinition

                        let lineRangeAtCursor =
                            let lines = sourceText.Split('\n')
                            let lineIndex = int position.Line - 1
                            if lineIndex < 0 || lineIndex >= lines.Length then None
                            else
                                let line = lines.[lineIndex].TrimEnd('\r')
                                Some(mkRange path (mkPos (lineIndex + 1) 0) (mkPos (lineIndex + 1) line.Length))

                        let fallbackRange =
                            match typeInfo with
                            | Some(_, tdi) ->
                                lineRangeAtCursor
                                |> Option.bind (fun r -> tryFindIdentifierRangeInRange r tdi.id)
                            | None -> tryFindDottedCandidateRangeAtPosition path sourceText position

                        let renameSymbol =
                            match typeInfo with
                            | Some(_, tdi) -> Some tdi.id
                            | None ->
                                fallbackRange
                                |> Option.bind tryGetSingleLineTextInRange
                                |> Option.map normalizeDefinitionSymbol
                                |> Option.filter (String.IsNullOrWhiteSpace >> not)

                        let refs =
                            let rawRefs =
                                match typeInfo with
                                | Some(typeName, tdi) -> game.FindAllRefsByType typeName tdi.id
                                | None ->
                                    game.FindAllRefs position path sourceText
                                    |> Option.defaultValue []

                            match renameSymbol with
                            | Some symbol -> rawRefs |> List.choose (fun r -> tryFindIdentifierRangeInRange r symbol)
                            | None -> []

                        let definitionRange =
                            typeInfo
                            |> Option.bind (fun (_, tdi) -> tryFindIdentifierRangeInDefinition tdi.range tdi.id)

                        let renameRanges =
                            refs
                            @ (definitionRange |> Option.toList)
                            @ (fallbackRange |> Option.toList)
                            |> List.distinctBy rangeKey

                        let localisationRenamePairs =
                            match typeInfo, renameSymbol with
                            | Some(typeName, tdi), Some oldSymbol ->
                                let typeDefsByName =
                                    game.TypeDefs()
                                    |> Seq.map (fun td -> td.name, td)
                                    |> Map.ofSeq

                                typeLocalisationRenamePairs typeDefsByName typeName tdi oldSymbol p.newName
                            | _ -> []

                        let localisationRenameEdits =
                            if List.isEmpty localisationRenamePairs then
                                []
                            else
                                let pairByOldKey = localisationRenamePairs |> Map.ofList
                                let visitor =
                                    { new IGameVisitor<_> with
                                        member _.Visit game = game.References().Localisation }

                                gameDispatcher.Dispatch visitor
                                |> Option.defaultValue []
                                |> List.choose (fun (locKey, entry) ->
                                    match Map.tryFind locKey pairByOldKey with
                                    | Some newLocKey ->
                                        tryFindLocalisationKeyRange entry locKey
                                        |> Option.map (fun r -> r, newLocKey)
                                    | None -> None)

                        let renameEdits =
                            (renameRanges |> List.map (fun r -> r, p.newName))
                            @ localisationRenameEdits
                            |> List.distinctBy (fun (r, _) -> rangeKey r)

                        match renameEdits with
                        | gotos when gotos.Length > 0 ->
                            let changes =
                                gotos
                                |> List.groupBy (fun (r, _) -> r.FileName)
                                |> List.map (fun (fileName, editsForFile) ->
                                    let uri = filePathToUri(fileName).ToString()
                                    let edits =
                                        editsForFile
                                        |> List.map (fun (r, newText) ->
                                            { range = convRangeToLSPRange r
                                              newText = newText })
                                    uri, edits)
                                |> Map.ofList

                            { documentChanges = None; changes = changes }
                        | _ -> { documentChanges = None; changes = Map.empty }
                    | None, None -> { documentChanges = None; changes = Map.empty }
            }
            |> catchError { documentChanges = None; changes = Map.empty }

        member this.ExecuteCommand(p: ExecuteCommandParams) : Async<ExecuteCommandResponse option> =
            let analysisFreshnessSnapshot () =
                let runtime = validationRuntimeSnapshot ()
                let loading = loadingRuntimeSnapshot ()
                let pendingDomains = pendingRefreshDomainList ()
                let staleReasons =
                    [ if loading.inProgress then yield "project_loading"
                      if runtime.inProgress then yield "validation_in_progress"
                      if not pendingDomains.IsEmpty then yield! pendingDomains |> List.map (fun value -> "pending_refresh:" + value) ]
                let status =
                    if loading.inProgress then "loading"
                    elif runtime.inProgress || not pendingDomains.IsEmpty then "partial"
                    else "fresh"
                status, staleReasons
            let validationStatusResult () =
                let currentEpoch = diagnosticEpoch.Value
                let currentModelEpoch = modelEpochSnapshot ()
                let totalFiles = fileDiagnosticStates.Count
                let pendingFiles =
                    fileDiagnosticStates.Values
                    |> Seq.filter (fun state ->
                        state.freshness <> Fresh
                        || not (sameModelEpoch state.modelEpoch currentModelEpoch))
                    |> Seq.length
                let allPendingKinds =
                    Seq.append
                        (fileDiagnosticStates.Values |> Seq.collect (fun state -> state.pendingGlobalKinds))
                        (pendingRefreshDomainList ())
                    |> Seq.distinct
                    |> Seq.toArray
                let pendingRefreshDomains = pendingRefreshDomainList ()
                let freshness =
                    if pendingFiles = 0 then "fresh"
                    elif pendingFiles < totalFiles then "pending"
                    else "stale"
                let runtime = validationRuntimeSnapshot ()
                let loading = loadingRuntimeSnapshot ()
                let modelReadyForKnowledgeExport =
                    not runtime.inProgress
                    && not loading.inProgress
                    && pendingRefreshDomains.IsEmpty
                JsonValue.Record
                    [| "ok",                 JsonValue.Boolean true
                       "epoch",              JsonValue.Number(decimal currentEpoch)
                       "modelEpoch",
                           JsonValue.Record
                               [| "game", JsonValue.Number(decimal currentModelEpoch.game)
                                  "rules", JsonValue.Number(decimal currentModelEpoch.rules)
                                  "types", JsonValue.Number(decimal currentModelEpoch.types)
                                  "localisation", JsonValue.Number(decimal currentModelEpoch.localisation) |]
                       "freshness",          JsonValue.String freshness
                       "totalFiles",         JsonValue.Number(decimal totalFiles)
                       "pendingFiles",       JsonValue.Number(decimal pendingFiles)
                       "pendingGlobalKinds", JsonValue.Array(allPendingKinds |> Array.map JsonValue.String)
                       "pendingRefreshDomains", JsonValue.Array(pendingRefreshDomains |> List.map JsonValue.String |> Array.ofList)
                       "modelReadyForKnowledgeExport", JsonValue.Boolean modelReadyForKnowledgeExport
                       "inProgress",         JsonValue.Boolean runtime.inProgress
                       "inProgressFile",     JsonValue.String runtime.inProgressFile
                       "queueDepth",         JsonValue.Number(decimal runtime.queueDepth)
                       "debounceQueueDepth", JsonValue.Number(decimal runtime.debounceQueueDepth)
                       "needsTypeRefresh",   JsonValue.Boolean needsTypeRefresh
                       "delayedLocalisationUpdate", JsonValue.Boolean delayedLocUpdate
                       "refreshSkipCount",   JsonValue.Number(decimal refreshSkipCount)
                       "nextAnalyzeDelayMs", JsonValue.Number(decimal (int delayTime.TotalMilliseconds))
                       "lastTypeRefreshRequestedAtUnixMs", JsonValue.Number(decimal (dateTimeToUnixMs lastTypeRefreshRequestAt))
                       "lastTypeRefreshCompletedAtUnixMs", JsonValue.Number(decimal (dateTimeToUnixMs lastTypeRefreshCompletedAt))
                       "lastGlobalRefreshAtUnixMs", JsonValue.Number(decimal (dateTimeToUnixMs lastGlobalRefreshAt))
                       "openDocuments",      JsonValue.Number(decimal (docs.OpenFiles() |> List.length))
                       "refreshDomains",     refreshDomainSnapshotJson ()
                       "runtime",            getRuntimeSnapshotJson ()
                       "loading",            getLoadingSnapshotJson ()
                       "completion",         getCompletionSnapshotJson ()
                       "diagnosticSummary",  getDiagnosticSummaryJson ()
                       "memory",             getMemorySnapshotJson ()
                       "caches",             getCacheSnapshotJson () |]

            let queryProjectKnowledgeDbCommand args =
                let optionsRecord =
                    args
                    |> List.tryHead
                    |> Option.bind (function JsonValue.Record fields -> Some fields | _ -> None)
                    |> Option.defaultValue [||]
                let tryProperty name = optionsRecord |> Array.tryPick (fun (key, value) -> if key = name then Some value else None)
                let stringProperty name =
                    match tryProperty name with
                    | Some (JsonValue.String value) when not (String.IsNullOrWhiteSpace value) -> Some value
                    | _ -> None
                let stringArray name =
                    match tryProperty name with
                    | Some (JsonValue.Array values) -> values |> Array.choose (function JsonValue.String value -> Some value | _ -> None) |> Array.toList
                    | _ -> []
                let boolProperty name fallback =
                    match tryProperty name with Some (JsonValue.Boolean value) -> value | _ -> fallback
                let intProperty name fallback =
                    match tryProperty name with Some (JsonValue.Number value) -> int value | _ -> fallback
                match stringProperty "databasePath" with
                | None ->
                    JsonValue.Record [| "ok", JsonValue.Boolean false; "status", JsonValue.String "error"; "error", JsonValue.String "databasePath is required." |]
                | Some databasePath ->
                    let projectRoots =
                        match workspaceFolders with
                        | folders when not folders.IsEmpty -> folders |> List.map (fun folder -> folder.uri.LocalPath)
                        | _ -> rootUri |> Option.map (fun uri -> uri.LocalPath) |> Option.toList
                    if not (Main.ProjectKnowledge.isKnowledgeDatabasePathAllowed projectRoots databasePath) then
                        JsonValue.Record
                            [| "ok", JsonValue.Boolean false
                               "status", JsonValue.String "error"
                               "error", JsonValue.String "Project knowledge database must be inside a project root." |]
                    else
                        let queryOptions: Main.ProjectKnowledge.QueryOptions =
                            { databasePath = databasePath
                              intent = stringProperty "intent"
                              domains = stringArray "domains"
                              identifiers = stringArray "identifiers"
                              entityTypes = stringArray "entityTypes"
                              includeProjectPatterns = boolProperty "includeProjectPatterns" true
                              includeVanillaArchetypes = boolProperty "includeVanillaArchetypes" true
                              includeTopology = boolProperty "includeTopology" true
                              includeUnresolved = boolProperty "includeUnresolved" true
                              includeEventGraph = boolProperty "includeEventGraph" true
                              limit = intProperty "limit" 80 }
                        try
                            Main.ProjectKnowledge.queryProjectKnowledgeDatabase queryOptions
                        with error ->
                            JsonValue.Record
                                [| "ok", JsonValue.Boolean false
                                   "status", JsonValue.String "error"
                                   "error", JsonValue.String error.Message |]
            if p.command = "cwtools.ai.getValidationStatus" then
                // Readiness must remain observable while the initial project load owns
                // the game-state write lock or has failed before gameObj is assigned.
                async.Return(Some(validationStatusResult ()))
            else async {
                let! cancellationToken = Async.CancellationToken
                return
                    match gameObj with
                    | Some game ->
                        let locationToJson (r: CWTools.Utilities.Position.range) =
                            let lspRange = convRangeToLSPRange r
                            JsonValue.Record
                                [| "uri", JsonValue.String(filePathToUri(r.FileName).ToString())
                                   "range",
                                   JsonValue.Record
                                       [| "start", codeLensPositionJson lspRange.start.line lspRange.start.character
                                          "end", codeLensPositionJson lspRange.``end``.line lspRange.``end``.character |] |]

                        // - cwtools.ai.shader.* shared helpers -
                        // All Shader queries are read-only; preflightEdit only analyzes the
                        // proposed text. Errors carry the operation and offending target.
                        let shaderErrorJson (operation: string) (target: string) (message: string) =
                            JsonValue.Record
                                [| "ok", JsonValue.Boolean false
                                   "status", JsonValue.String "error"
                                   "operation", JsonValue.String operation
                                   "target", JsonValue.String target
                                   "error", JsonValue.String message |]

                        let shaderArgsRecord (args: JsonValue list) =
                            args
                            |> List.tryHead
                            |> Option.bind (function JsonValue.Record fields -> Some fields | _ -> None)
                            |> Option.defaultValue [||]

                        let shaderTryProperty name (fields: (string * JsonValue) array) =
                            fields |> Array.tryPick (fun (key, value) -> if key = name then Some value else None)

                        let shaderStringProperty name fields =
                            match shaderTryProperty name fields with
                            | Some (JsonValue.String value) when not (String.IsNullOrWhiteSpace value) -> Some value
                            | _ -> None

                        let shaderRawStringProperty name fields =
                            match shaderTryProperty name fields with
                            | Some (JsonValue.String value) -> Some value
                            | _ -> None

                        let shaderIntProperty name fields =
                            match shaderTryProperty name fields with
                            | Some (JsonValue.Number value) -> Some(int value)
                            | _ -> None

                        let shaderLimit (operation: string) fields : Choice<int, JsonValue> =
                            match shaderIntProperty "limit" fields with
                            | None -> Choice1Of2 100
                            | Some value when value >= 1 && value <= 500 -> Choice1Of2 value
                            | Some _ -> Choice2Of2(shaderErrorJson operation "limit" "limit must be between 1 and 500.")

                        let shaderCursor fields =
                            match shaderIntProperty "cursor" fields with
                            | Some value when value >= 0 -> value
                            | _ -> 0

                        let shaderOriginName (origin: PdxShaderProject.ShaderOrigin) =
                            match origin with
                            | PdxShaderProject.CurrentDocument -> "current_document"
                            | PdxShaderProject.Workspace -> "workspace"
                            | PdxShaderProject.Dependency order -> sprintf "dependency:%d" order
                            | PdxShaderProject.Vanilla -> "vanilla"

                        let captureOpenShaderScriptDocuments () =
                            docs.OpenFiles()
                            |> List.choose (fun (fileInfo: FileInfo) ->
                                let path = fileInfo.FullName

                                if
                                    PdxShaderFeatures.isShaderFile path
                                    || PdxShaderRuntime.isEvidenceScriptFile path
                                then
                                    docs.Get fileInfo |> Option.map (fun (text, version) -> path, text, version)
                                else
                                    None)
                            |> List.sortBy (fun (path, _, _) -> PdxShaderProject.canonicalizePath path)

                        let openShaderScriptDocuments () =
                            captureOpenShaderScriptDocuments ()
                            |> List.map (fun (path, text, _) -> path, text)

                        let shaderRuntimeModel () =
                            let rec resolve attempt =
                                let epoch = modelEpochSnapshot ()
                                let captured = captureOpenShaderScriptDocuments ()
                                let openDocs = captured |> List.map (fun (path, text, _) -> path, text)
                                let shaderGameVersion = if activeGame = STL then stlGameVersion else None

                                // Do not use String.GetHashCode here: a collision or
                                // nondeterministic dictionary order could reuse the
                                // wrong immutable runtime graph. Content hashes keep
                                // the one-entry key deterministic and auditable.
                                let documentKey =
                                    [ yield shaderGameVersion |> Option.defaultValue "unknown"
                                      for path, text, version in captured do
                                          yield
                                              String.concat
                                                  "|"
                                                  [ PdxShaderProject.canonicalizePath path
                                                    string version
                                                    PdxShaderProject.contentHashForText text ] ]
                                    |> String.concat "\n"

                                let model =
                                    lock shaderRuntimeModelCacheLock (fun () ->
                                        match shaderRuntimeModelCache with
                                        | Some(cachedEpoch, cachedDocumentKey, cachedModel) when
                                            sameModelEpoch cachedEpoch epoch
                                            && cachedDocumentKey = documentKey
                                            ->
                                            cachedModel
                                        | _ ->
                                            let rebuilt = PdxShaderRuntime.buildModel shaderGameVersion (game.AllFiles()) openDocs
                                            shaderRuntimeModelCache <- Some(epoch, documentKey, rebuilt)
                                            rebuilt)

                                let documentsStillCurrent =
                                    captured
                                    |> List.forall (fun (path, _, version) -> docs.GetVersionByPath path = Some version)

                                if documentsStillCurrent && sameModelEpoch epoch (modelEpochSnapshot ()) then
                                    model
                                elif attempt < 2 then
                                    resolve (attempt + 1)
                                else
                                    raise (OperationCanceledException("Shader runtime inputs changed while the query was running."))

                            resolve 0

                        // A shader file path is accepted when it is inside a workspace root
                        // or matches a known resource / vanilla / open-document shader file.
                        let shaderPathFromUri (operation: string) (uriText: string) : Choice<string, JsonValue> =
                            let filePath =
                                try
                                    getPathFromDoc (Uri uriText)
                                with _ ->
                                    ""

                            if String.IsNullOrWhiteSpace filePath then
                                Choice2Of2(shaderErrorJson operation uriText "uri is not a valid file URI.")
                            elif not (PdxShaderFeatures.isShaderFile filePath) then
                                Choice2Of2(shaderErrorJson operation uriText "uri must reference a .shader or .fxh file.")
                            else
                                let canonical = PdxShaderProject.canonicalizePath filePath

                                let workspaceRoots =
                                    match workspaceFolders with
                                    | folders when not folders.IsEmpty -> folders |> List.map (fun folder -> folder.uri.LocalPath)
                                    | _ -> rootUri |> Option.map (fun uri -> uri.LocalPath) |> Option.toList

                                let inWorkspace =
                                    workspaceRoots
                                    |> List.exists (fun root ->
                                        let rootCanonical = PdxShaderProject.canonicalizePath root

                                        canonical = rootCanonical
                                        || canonical.StartsWith(rootCanonical + "/", StringComparison.Ordinal))

                                let isKnownResource =
                                    game.AllFiles()
                                    |> Seq.exists (fun resource ->
                                        let path =
                                            match resource with
                                            | FileResource(_, r) -> r.filepath
                                            | FileWithContentResource(_, r) -> r.filepath
                                            | EntityResource(_, r) -> r.filepath

                                        PdxShaderFeatures.isShaderFile path
                                        && PdxShaderProject.canonicalizePath path = canonical)

                                let isKnownVanilla =
                                    PdxShaderFeatures.vanillaShaderSources ()
                                    |> List.exists (fun source -> PdxShaderProject.canonicalizePath source.filepath = canonical)

                                let isOpen = docs.GetTextByPath filePath |> Option.isSome

                                if inWorkspace || isKnownResource || isKnownVanilla || isOpen then
                                    Choice1Of2 filePath
                                else
                                    Choice2Of2(
                                        shaderErrorJson operation uriText "path is outside the workspace and the known shader roots."
                                    )

                        let shaderEditPathFromUri (operation: string) (uriText: string) : Choice<string, JsonValue> =
                            let filePath =
                                try
                                    getPathFromDoc (Uri uriText)
                                with _ ->
                                    ""

                            if String.IsNullOrWhiteSpace filePath then
                                Choice2Of2(shaderErrorJson operation uriText "uri is not a valid file URI.")
                            elif PdxShaderFeatures.isShaderFile filePath then
                                shaderPathFromUri operation uriText
                            elif Path.GetExtension(filePath).Equals(".gfx", StringComparison.OrdinalIgnoreCase) then
                                let canonical = PdxShaderProject.canonicalizePath filePath
                                let workspaceRoots =
                                    match workspaceFolders with
                                    | folders when not folders.IsEmpty -> folders |> List.map (fun folder -> folder.uri.LocalPath)
                                    | _ -> rootUri |> Option.map (fun uri -> uri.LocalPath) |> Option.toList
                                let inWorkspace =
                                    workspaceRoots
                                    |> List.exists (fun root ->
                                        let rootCanonical = PdxShaderProject.canonicalizePath root
                                        canonical = rootCanonical
                                        || canonical.StartsWith(rootCanonical + "/", StringComparison.Ordinal))

                                if inWorkspace then Choice1Of2 filePath
                                else Choice2Of2(shaderErrorJson operation uriText "interface .gfx writes must stay inside a workspace root.")
                            else
                                Choice2Of2(shaderErrorJson operation uriText "uri must reference a .shader, .fxh, or interface .gfx file.")

                        let shaderEvidenceJson (model: PdxShaderRuntime.ShaderRuntimeModel) (evidence: PdxShaderRuntime.ShaderCallEvidence) =
                            let invocation =
                                model.interfaceSprites
                                |> List.tryFind (fun candidate ->
                                    PdxShaderProject.sameFilePath candidate.sourceFile evidence.sourceFile
                                    && candidate.shaderFileSpan = evidence.span)

                            let rendererContract =
                                invocation |> Option.bind (PdxShaderRuntime.rendererContractForInvocation model)

                            let rendererContractIssues =
                                invocation
                                |> Option.map (PdxShaderRuntime.validateRendererInvocation model)
                                |> Option.defaultValue []

                            let guiUses =
                                match evidence.interfaceSprite with
                                | Some spriteName ->
                                    model.guiSpriteUses
                                    |> List.filter (fun guiUse -> guiUse.spriteName.Equals(spriteName, StringComparison.OrdinalIgnoreCase))
                                    |> List.sortBy (fun guiUse -> guiUse.sourceFile, guiUse.span.StartLine, guiUse.span.StartColumn)
                                | None -> []

                            let guiUseJson (guiUse: PdxShaderRuntime.GuiSpriteUse) =
                                JsonValue.Record
                                    [| "spriteName", JsonValue.String guiUse.spriteName
                                       "file", JsonValue.String(guiUse.sourceFile.Replace('\\', '/'))
                                       "logicalPath", JsonValue.String guiUse.logicalPath
                                       "origin", JsonValue.String(shaderOriginName guiUse.origin)
                                       "enclosingBlock",
                                       (match guiUse.enclosingBlock with
                                        | Some block -> JsonValue.String block
                                        | None -> JsonValue.Null)
                                       "range", locationToJson guiUse.span |]

                            let rendererInputJson (input: PdxShaderRuntime.InterfaceSpriteInput) =
                                JsonValue.Record
                                    [| "field", JsonValue.String input.field
                                       "value", JsonValue.String input.value
                                       "range", locationToJson input.span |]

                            JsonValue.Record
                                [| "kind",
                                   JsonValue.String(
                                       match evidence.kind with
                                       | PdxShaderRuntime.ShaderAssignment -> "shader_assignment"
                                       | PdxShaderRuntime.EffectFileSelection -> "effect_file_selection"
                                   )
                                   "value", JsonValue.String evidence.value
                                   "file", JsonValue.String(evidence.sourceFile.Replace('\\', '/'))
                                   "logicalPath", JsonValue.String evidence.logicalPath
                                   "origin", JsonValue.String(shaderOriginName evidence.origin)
                                   "enclosingBlock",
                                   (match evidence.enclosingBlock with
                                    | Some block -> JsonValue.String block
                                    | None -> JsonValue.Null)
                                   "interfaceSprite",
                                   (match evidence.interfaceSprite with
                                    | Some name -> JsonValue.String name
                                    | None -> JsonValue.Null)
                                   "rendererSubtype",
                                   (match evidence.rendererSubtype with
                                    | Some subtype -> JsonValue.String subtype
                                    | None -> JsonValue.Null)
                                   "rendererInputs",
                                   JsonValue.Array(
                                       invocation
                                       |> Option.map _.resourceInputs
                                       |> Option.defaultValue []
                                       |> List.map rendererInputJson
                                       |> Array.ofList
                                   )
                                   "frameCount",
                                   (match invocation |> Option.bind _.frameCount with
                                    | Some count -> JsonValue.Number(decimal count)
                                    | None -> JsonValue.Null)
                                   "rendererContract",
                                   (match rendererContract with
                                    | Some contract ->
                                        JsonValue.Record
                                            [| "gameVersion", JsonValue.String contract.gameVersion
                                               "effects", JsonValue.Array(contract.effects |> List.map JsonValue.String |> Array.ofList)
                                               "requiredInputs", JsonValue.Array(contract.requiredInputs |> List.map JsonValue.String |> Array.ofList)
                                               "evidence", JsonValue.String contract.evidence
                                               "valid", JsonValue.Boolean rendererContractIssues.IsEmpty
                                               "issues", JsonValue.Array(rendererContractIssues |> List.map JsonValue.String |> Array.ofList) |]
                                    | None -> JsonValue.Null)
                                   "guiUseCount", JsonValue.Number(decimal guiUses.Length)
                                   "guiUses", JsonValue.Array(guiUses |> List.truncate 20 |> List.map guiUseJson |> Array.ofList)
                                   "guiUsesTruncated", JsonValue.Boolean(guiUses.Length > 20)
                                   "range", locationToJson evidence.span
                                   "provenance",
                                   JsonValue.Record
                                       [| "sourceKind", JsonValue.String(PdxShaderRuntime.evidenceSourceKind evidence)
                                          "confidence", JsonValue.String(PdxShaderRuntime.evidenceConfidence evidence)
                                          "gameVersion", JsonValue.String model.gameVersion |] |]

                        let shaderDeclarationKindName (kind: PdxShaderRuntime.ShaderDeclarationKind) =
                            match kind with
                            | PdxShaderRuntime.EffectDeclaration -> "effect", ""
                            | PdxShaderRuntime.VertexMainCodeDeclaration -> "maincode", "vertex"
                            | PdxShaderRuntime.PixelMainCodeDeclaration -> "maincode", "pixel"
                            | PdxShaderRuntime.GeometryMainCodeDeclaration -> "maincode", "geometry"
                            | PdxShaderRuntime.VertexStructDeclaration -> "struct", "vertex"
                            | PdxShaderRuntime.ConstantBufferDeclaration -> "constantbuffer", ""
                            | PdxShaderRuntime.SamplerDeclaration -> "sampler", ""
                            | PdxShaderRuntime.ShaderResourceDeclaration -> "resource", ""
                            | PdxShaderRuntime.HlslTypeDeclaration -> "hlsl_type", ""
                            | PdxShaderRuntime.HlslFunctionDeclaration -> "hlsl_function", ""
                            | PdxShaderRuntime.HlslVariableDeclaration -> "hlsl_variable", ""
                            | PdxShaderRuntime.MacroDeclaration -> "macro", ""
                            | PdxShaderRuntime.BlendStateDeclaration -> "state", "blend"
                            | PdxShaderRuntime.DepthStencilStateDeclaration -> "state", "depth_stencil"
                            | PdxShaderRuntime.RasterizerStateDeclaration -> "state", "rasterizer"

                        let shaderDeclarationJson (declaration: PdxShaderRuntime.ShaderDeclaration) =
                            let kindName, stage = shaderDeclarationKindName declaration.kind

                            JsonValue.Record
                                [| "stableId", JsonValue.String declaration.stableId
                                   "name", JsonValue.String declaration.name
                                   "kind", JsonValue.String kindName
                                   "stage", JsonValue.String stage
                                   "file", JsonValue.String(declaration.file.Replace('\\', '/'))
                                   "logicalPath", JsonValue.String declaration.logicalPath
                                   "origin", JsonValue.String(shaderOriginName declaration.origin)
                                   "presenceCondition", JsonValue.String declaration.presenceCondition
                                   "detail", (declaration.detail |> Option.map JsonValue.String |> Option.defaultValue JsonValue.Null)
                                   "range", locationToJson declaration.range
                                   "nameRange", locationToJson declaration.selectionRange |]

                        let shaderReachabilityName (reachability: PdxShaderRuntime.EffectReachability) =
                            match reachability with
                            | PdxShaderRuntime.DataExplicit _ -> "data_explicit"
                            | PdxShaderRuntime.EffectFileConvention _ -> "effect_file_convention"
                            | PdxShaderRuntime.EffectFileConventionCandidate _ -> "effect_file_convention_candidate"
                            | PdxShaderRuntime.EngineHardcoded _ -> "engine_hardcoded"
                            | PdxShaderRuntime.EngineOrUnreferenced -> "engine_or_unreferenced"

                        let shaderRenamePolicyJson (decision: PdxShaderRuntime.RenamePolicyDecision) =
                            let name, reason =
                                match decision with
                                | PdxShaderRuntime.RenameAllowed reason -> "allowed", reason
                                | PdxShaderRuntime.RenameRequiresExplicitForce reason -> "requires_explicit_force", reason
                                | PdxShaderRuntime.RenameDenied reason -> "denied", reason

                            JsonValue.Record
                                [| "decision", JsonValue.String name
                                   "reason", JsonValue.String reason |]

                        let shaderAbiAuditJson (model: PdxShaderRuntime.ShaderRuntimeModel) =
                            let audit = PdxShaderRuntime.verifyShaderAbiAudit model
                            JsonValue.Record
                                [| "status", JsonValue.String audit.status
                                   "source", (audit.source |> Option.map (fun value -> JsonValue.String(value.Replace('\\', '/'))) |> Option.defaultValue JsonValue.Null)
                                   "gameVersion", JsonValue.String audit.gameVersion
                                   "reviewStatus", (audit.reviewStatus |> Option.map JsonValue.String |> Option.defaultValue JsonValue.Null)
                                   "automaticPromotion", JsonValue.Boolean audit.automaticPromotion
                                   "shaderFiles", (audit.shaderFileCount |> Option.map (decimal >> JsonValue.Number) |> Option.defaultValue JsonValue.Null)
                                   "modelVanillaShaderFiles", JsonValue.Number(decimal audit.modelVanillaShaderFiles)
                                   "auditedEffectDeclarations", (audit.auditedEffectDeclarations |> Option.map (decimal >> JsonValue.Number) |> Option.defaultValue JsonValue.Null)
                                   "auditedUniqueEffectNames", (audit.auditedUniqueEffectNames |> Option.map (decimal >> JsonValue.Number) |> Option.defaultValue JsonValue.Null)
                                   "modelVanillaEffectDeclarations", JsonValue.Number(decimal audit.modelVanillaEffectDeclarations)
                                   "modelVanillaUniqueEffectNames", JsonValue.Number(decimal audit.modelVanillaUniqueEffectNames)
                                   "confirmedEngineEntryCount", JsonValue.Number(decimal audit.confirmedEngineEntryCount)
                                   "activeCatalogEntryCount", JsonValue.Number(decimal audit.activeCatalogEntryCount)
                                   "corpusMatches", JsonValue.Boolean audit.corpusMatches
                                   "diagnostics",
                                   JsonValue.Array(
                                       audit.diagnostics
                                       |> List.map (fun diagnostic ->
                                           JsonValue.Record
                                               [| "code", JsonValue.String diagnostic.code
                                                  "message", JsonValue.String diagnostic.message
                                                  "source", JsonValue.String diagnostic.source |])
                                       |> List.toArray
                                   ) |]

                        let shaderEffectJson (model: PdxShaderRuntime.ShaderRuntimeModel) (result: PdxShaderRuntime.EffectReachabilityResult) =
                            JsonValue.Record
                                [| "name", JsonValue.String result.name
                                   "classification", JsonValue.String(shaderReachabilityName result.reachability)
                                   "declarations",
                                   JsonValue.Array(result.declarations |> List.map shaderDeclarationJson |> Array.ofList)
                                   "evidence",
                                   JsonValue.Array(result.evidence |> List.map (shaderEvidenceJson model) |> Array.ofList)
                                   "provenance",
                                   JsonValue.Record
                                       [| "confidence", JsonValue.String(PdxShaderRuntime.reachabilityConfidence result.reachability)
                                          "gameVersion", JsonValue.String model.gameVersion
                                          "abiAudit", shaderAbiAuditJson model |]
                                   "renamePolicy", shaderRenamePolicyJson (PdxShaderRuntime.renamePolicy model result.name) |]

                        match p with
                        // - cwtools.ai.shader.symbols -
                        // Declared shader symbols (effects, maincodes, constant buffers,
                        // states) with file/span/origin and, for effects, the classification.
                        | { command = "cwtools.ai.shader.symbols"
                            arguments = args } ->
                            let fields = shaderArgsRecord args
                            let operation = "cwtools.ai.shader.symbols"

                            match shaderLimit operation fields with
                            | Choice2Of2 error -> Some error
                            | Choice1Of2 limit ->
                                let kindFilter = shaderStringProperty "kind" fields |> Option.defaultValue "all"
                                let validKinds = set [ "all"; "effect"; "maincode"; "constantbuffer"; "state" ]

                                if not (validKinds.Contains kindFilter) then
                                    Some(
                                        shaderErrorJson
                                            operation
                                            "kind"
                                            (sprintf "unknown kind \"%s\"; expected one of: all, effect, maincode, constantbuffer, state." kindFilter)
                                    )
                                else
                                    let filter = shaderStringProperty "filter" fields
                                    let cursor = shaderCursor fields
                                    let model = shaderRuntimeModel ()

                                    let classificationOf (declaration: PdxShaderRuntime.ShaderDeclaration) =
                                        if declaration.kind = PdxShaderRuntime.EffectDeclaration then
                                            model.effects
                                            |> List.tryFind (fun info ->
                                                info.declaration.file = declaration.file
                                                && info.declaration.name = declaration.name
                                                && info.declaration.selectionRange = declaration.selectionRange)
                                            |> Option.map (fun info -> shaderReachabilityName info.reachability)
                                        else
                                            None

                                    let filtered =
                                        model.declarations
                                        |> List.filter (fun declaration ->
                                            let kindName, _ = shaderDeclarationKindName declaration.kind

                                            (kindFilter = "all" || kindName = kindFilter)
                                            && (match filter with
                                                | Some value -> declaration.name.IndexOf(value, StringComparison.OrdinalIgnoreCase) >= 0
                                                | None -> true))
                                        |> List.sortBy (fun declaration ->
                                            declaration.name.ToLowerInvariant(),
                                            PdxShaderProject.originRank declaration.origin,
                                            declaration.file)

                                    let page = filtered |> List.skip (min cursor filtered.Length) |> List.truncate limit

                                    let symbolJson declaration =
                                        match shaderDeclarationJson declaration, classificationOf declaration with
                                        | JsonValue.Record recordFields, Some classification ->
                                            JsonValue.Record(
                                                Array.append recordFields [| "classification", JsonValue.String classification |]
                                            )
                                        | json, _ -> json

                                    Some(
                                        JsonValue.Record
                                            [| "ok", JsonValue.Boolean true
                                               "gameVersion", JsonValue.String model.gameVersion
                                               "totalCount", JsonValue.Number(decimal filtered.Length)
                                               "returnedCount", JsonValue.Number(decimal page.Length)
                                               "nextCursor",
                                               (if cursor + page.Length < filtered.Length then
                                                    JsonValue.Number(decimal (cursor + page.Length))
                                                else
                                                    JsonValue.Null)
                                               "symbols", JsonValue.Array(page |> List.map symbolJson |> Array.ofList) |]
                                    )

                        // - cwtools.ai.shader.compileUnit -
                        // Root, include members with resolution status, and reverse deps.
                        | { command = "cwtools.ai.shader.compileUnit"
                            arguments = args } ->
                            let fields = shaderArgsRecord args
                            let operation = "cwtools.ai.shader.compileUnit"

                            match shaderStringProperty "uri" fields with
                            | None -> Some(shaderErrorJson operation "uri" "uri is required.")
                            | Some uriText ->
                                match shaderPathFromUri operation uriText with
                                | Choice2Of2 error -> Some error
                                | Choice1Of2 filePath ->
                                    let openDocs =
                                        openShaderScriptDocuments ()
                                        |> List.filter (fun (path, _) -> PdxShaderFeatures.isShaderFile path)

                                    match PdxShaderRuntime.compileUnitFor (game.AllFiles()) openDocs filePath with
                                    | None ->
                                        Some(
                                            shaderErrorJson operation uriText "file is not a known shader file in the workspace, dependencies or vanilla."
                                        )
                                    | Some (unit, snapshots) ->
                                        let effectivePaths =
                                            unit.effective |> List.map (fun snapshot -> snapshot.canonicalPath) |> Set.ofList

                                        let memberJson (snapshot: PdxShaderProject.ShaderSnapshot) =
                                            JsonValue.Record
                                                [| "path", JsonValue.String(snapshot.displayPath.Replace('\\', '/'))
                                                   "logicalPath", JsonValue.String snapshot.logicalPath
                                                   "origin", JsonValue.String(shaderOriginName snapshot.origin)
                                                   "effective", JsonValue.Boolean(Set.contains snapshot.canonicalPath effectivePaths)
                                                   "status", JsonValue.String "resolved" |]

                                        let snapshotFor includingPath =
                                            let canonical = PdxShaderProject.canonicalizePath includingPath
                                            snapshots |> List.tryFind (fun snapshot -> snapshot.canonicalPath = canonical)

                                        let rangeOf includingPath start length =
                                            snapshotFor includingPath
                                            |> Option.map (fun snapshot ->
                                                locationToJson (PdxShaderRuntime.offsetRange snapshot.displayPath snapshot.text start length))
                                            |> Option.defaultValue JsonValue.Null

                                        let problemJson problem =
                                            match problem with
                                            | PdxShaderProject.MissingInclude(includingPath, target, start, length) ->
                                                JsonValue.Record
                                                    [| "kind", JsonValue.String "missing"
                                                       "target", JsonValue.String target
                                                       "includingFile", JsonValue.String(includingPath.Replace('\\', '/'))
                                                       "range", rangeOf includingPath start length |]
                                            | PdxShaderProject.AmbiguousInclude(includingPath, target, start, length, candidates) ->
                                                JsonValue.Record
                                                    [| "kind", JsonValue.String "ambiguous"
                                                       "target", JsonValue.String target
                                                       "includingFile", JsonValue.String(includingPath.Replace('\\', '/'))
                                                       "range", rangeOf includingPath start length
                                                       "candidates",
                                                       JsonValue.Array(
                                                           candidates
                                                           |> List.map (fun candidate -> JsonValue.String(candidate.Replace('\\', '/')))
                                                           |> Array.ofList
                                                       ) |]
                                            | PdxShaderProject.CyclicInclude(includingPath, target, start, length, cyclePath) ->
                                                JsonValue.Record
                                                    [| "kind", JsonValue.String "cycle"
                                                       "target", JsonValue.String target
                                                       "includingFile", JsonValue.String(includingPath.Replace('\\', '/'))
                                                       "range", rangeOf includingPath start length
                                                       "cyclePath",
                                                       JsonValue.Array(
                                                           cyclePath
                                                           |> List.map (fun path -> JsonValue.String(path.Replace('\\', '/')))
                                                           |> Array.ofList
                                                       ) |]
                                            | PdxShaderProject.IncludeBudgetExceeded(includingPath, target, start, length, budget, limit) ->
                                                JsonValue.Record
                                                    [| "kind", JsonValue.String "budget_exceeded"
                                                       "target", JsonValue.String target
                                                       "includingFile", JsonValue.String(includingPath.Replace('\\', '/'))
                                                       "range", rangeOf includingPath start length
                                                       "budget", JsonValue.String budget
                                                       "limit", JsonValue.Number(decimal limit) |]

                                        Some(
                                            JsonValue.Record
                                                [| "ok", JsonValue.Boolean true
                                                   "root",
                                                   JsonValue.Record
                                                       [| "path", JsonValue.String(unit.root.displayPath.Replace('\\', '/'))
                                                          "logicalPath", JsonValue.String unit.root.logicalPath
                                                          "origin", JsonValue.String(shaderOriginName unit.root.origin) |]
                                                   "members", JsonValue.Array(unit.members |> List.map memberJson |> Array.ofList)
                                                   "problems", JsonValue.Array(unit.problems |> List.map problemJson |> Array.ofList)
                                                   "includedBy",
                                                   JsonValue.Array(
                                                       PdxShaderRuntime.reverseIncluders snapshots filePath
                                                       |> List.map (fun path -> JsonValue.String(path.Replace('\\', '/')))
                                                       |> Array.ofList
                                                   ) |]
                                        )

                        // - cwtools.ai.shader.variants -
                        // Presence conditions and active symbols for each supported platform profile.
                        | { command = "cwtools.ai.shader.variants"
                            arguments = args } ->
                            let fields = shaderArgsRecord args
                            let operation = "cwtools.ai.shader.variants"

                            match shaderStringProperty "uri" fields with
                            | None -> Some(shaderErrorJson operation "uri" "uri is required.")
                            | Some uriText ->
                                match shaderPathFromUri operation uriText with
                                | Choice2Of2 error -> Some error
                                | Choice1Of2 filePath ->
                                    let openDocs =
                                        openShaderScriptDocuments ()
                                        |> List.filter (fun (path, _) -> PdxShaderFeatures.isShaderFile path)

                                    match PdxShaderRuntime.compileUnitFor (game.AllFiles()) openDocs filePath with
                                    | None ->
                                        Some(shaderErrorJson operation uriText "file is not a known shader file in the workspace, dependencies or vanilla.")
                                    | Some (unit, _) ->
                                        let parsed =
                                            unit.effective
                                            |> List.map (fun snapshot -> snapshot, PdxShaderProject.semanticSnapshot snapshot)
                                        let conditions =
                                            parsed
                                            |> List.collect (fun (_, semantic) ->
                                                semantic.preprocessor.regions |> List.map _.condition)
                                            |> List.distinctBy (sprintf "%A")
                                        let nodeKindName =
                                            function
                                            | PdxShaderSyntax.ShaderNodeKind.Effect -> Some "effect"
                                            | PdxShaderSyntax.ShaderNodeKind.MainCode -> Some "maincode"
                                            | PdxShaderSyntax.ShaderNodeKind.VertexStruct -> Some "vertex_struct"
                                            | PdxShaderSyntax.ShaderNodeKind.ConstantBuffer -> Some "constant_buffer"
                                            | PdxShaderSyntax.ShaderNodeKind.BlendState -> Some "blend_state"
                                            | PdxShaderSyntax.ShaderNodeKind.DepthStencilState -> Some "depth_stencil_state"
                                            | PdxShaderSyntax.ShaderNodeKind.RasterizerState -> Some "rasterizer_state"
                                            | PdxShaderSyntax.ShaderNodeKind.Sampler -> Some "sampler"
                                            | _ -> None
                                        let symbolFacts =
                                            parsed
                                            |> List.collect (fun (snapshot, semantic) ->
                                                let outer =
                                                    PdxShaderSyntax.descendants semantic.syntax.root
                                                    |> Seq.choose (fun node ->
                                                        match nodeKindName node.kind, node.name, node.nameSpan with
                                                        | Some kind, Some name, Some nameSpan ->
                                                            Some(
                                                                name,
                                                                kind,
                                                                snapshot.displayPath,
                                                                PdxShaderPreprocessor.conditionAt nameSpan.startOffset semantic.preprocessor
                                                            )
                                                        | _ -> None)
                                                    |> Seq.toList
                                                let hlsl =
                                                    semantic.hlsl.symbols
                                                    |> List.map (fun symbol ->
                                                        symbol.name,
                                                        (sprintf "hlsl_%A" symbol.kind).ToLowerInvariant(),
                                                        snapshot.displayPath,
                                                        symbol.condition)
                                                outer @ hlsl)
                                            |> List.distinctBy (fun (name, kind, path, condition) -> name, kind, path, sprintf "%A" condition)
                                        let symbolJson
                                            (name: string, kind: string, path: string, condition: PdxShaderPreprocessor.PresenceCondition)
                                            =
                                            JsonValue.Record
                                                [| "name", JsonValue.String name
                                                   "kind", JsonValue.String kind
                                                   "file", JsonValue.String(path.Replace('\\', '/'))
                                                   "presenceCondition", JsonValue.String(sprintf "%A" condition) |]
                                        let variantJson (variant: PdxShaderPreprocessor.PlatformVariant) =
                                            let active =
                                                symbolFacts
                                                |> List.filter (fun (_, _, _, condition) ->
                                                    PdxShaderPreprocessor.evaluate variant.environment condition
                                                    <> PdxShaderPreprocessor.ConditionFalse)
                                                |> List.sortBy (fun (name, kind, path, _) -> kind, name, path)
                                            JsonValue.Record
                                                [| "name", JsonValue.String variant.name
                                                   "definedMacros", JsonValue.Array(variant.environment.defined |> Seq.sort |> Seq.map JsonValue.String |> Seq.toArray)
                                                   "activeSymbolCount", JsonValue.Number(decimal active.Length)
                                                   "activeSymbols", JsonValue.Array(active |> List.truncate 500 |> List.map symbolJson |> Array.ofList)
                                                   "symbolsTruncated", JsonValue.Boolean(active.Length > 500) |]
                                        let conditionJson (item: PdxShaderPreprocessor.VariantCondition) =
                                            JsonValue.Record
                                                [| "condition", JsonValue.String(sprintf "%A" item.condition)
                                                   "activeVariants", JsonValue.Array(item.activeVariants |> List.map JsonValue.String |> Array.ofList)
                                                   "unknownVariants", JsonValue.Array(item.unknownVariants |> List.map JsonValue.String |> Array.ofList) |]
                                        let macroJson (snapshot: PdxShaderProject.ShaderSnapshot, semantic: PdxShaderProject.ShaderSemanticSnapshot) =
                                            semantic.preprocessor.macros
                                            |> List.map (fun macro ->
                                                JsonValue.Record
                                                    [| "name", JsonValue.String macro.name
                                                       "kind", JsonValue.String(sprintf "%A" macro.kind)
                                                       "replacement", JsonValue.String macro.replacement
                                                       "presenceCondition", JsonValue.String(sprintf "%A" macro.condition)
                                                       "file", JsonValue.String(snapshot.displayPath.Replace('\\', '/')) |])

                                        Some(
                                            JsonValue.Record
                                                [| "ok", JsonValue.Boolean true
                                                   "root", JsonValue.String(unit.root.displayPath.Replace('\\', '/'))
                                                   "platforms", JsonValue.Array(PdxShaderPreprocessor.defaultPlatformVariants |> List.map variantJson |> Array.ofList)
                                                   "conditions",
                                                   JsonValue.Array(
                                                       PdxShaderPreprocessor.compareVariants PdxShaderPreprocessor.defaultPlatformVariants conditions
                                                       |> List.map conditionJson
                                                       |> Array.ofList
                                                   )
                                                   "macros", JsonValue.Array(parsed |> List.collect macroJson |> Array.ofList) |]
                                        )

                        // - cwtools.ai.shader.callers -
                        // All located `shader = effectName` call sites with spans and origin.
                        | { command = "cwtools.ai.shader.callers"
                            arguments = args } ->
                            let fields = shaderArgsRecord args
                            let operation = "cwtools.ai.shader.callers"

                            match shaderStringProperty "effectName" fields with
                            | None -> Some(shaderErrorJson operation "effectName" "effectName is required.")
                            | Some effectName ->
                                match shaderLimit operation fields with
                                | Choice2Of2 error -> Some error
                                | Choice1Of2 limit ->
                                    let model = shaderRuntimeModel ()
                                    let callers = PdxShaderRuntime.callersOf model effectName
                                    let page = callers |> List.truncate limit

                                    Some(
                                        JsonValue.Record
                                            [| "ok", JsonValue.Boolean true
                                               "effectName", JsonValue.String effectName
                                               "totalCount", JsonValue.Number(decimal callers.Length)
                                               "returnedCount", JsonValue.Number(decimal page.Length)
                                               "callers",
                                               JsonValue.Array(page |> List.map (shaderEvidenceJson model) |> Array.ofList) |]
                                    )

                        // - cwtools.ai.shader.reachability -
                        // Classification + evidence + provenance + rename policy per effect,
                        // by name or for every effect declared in a file (paginated).
                        | { command = "cwtools.ai.shader.reachability"
                            arguments = args } ->
                            let fields = shaderArgsRecord args
                            let operation = "cwtools.ai.shader.reachability"

                            match shaderStringProperty "effectName" fields, shaderStringProperty "uri" fields with
                            | None, None -> Some(shaderErrorJson operation "effectName" "effectName or uri is required.")
                            | Some effectName, _ ->
                                let model = shaderRuntimeModel ()

                                match PdxShaderRuntime.effectReachability model effectName with
                                | Some result ->
                                    Some(
                                        JsonValue.Record
                                            [| "ok", JsonValue.Boolean true
                                               "effect", shaderEffectJson model result |]
                                    )
                                | None ->
                                    Some(shaderErrorJson operation effectName "effect is not declared in the known shader files.")
                            | None, Some uriText ->
                                match shaderPathFromUri operation uriText with
                                | Choice2Of2 error -> Some error
                                | Choice1Of2 filePath ->
                                    match shaderLimit operation fields with
                                    | Choice2Of2 error -> Some error
                                    | Choice1Of2 limit ->
                                        let cursor = shaderCursor fields
                                        let model = shaderRuntimeModel ()
                                        let canonical = PdxShaderProject.canonicalizePath filePath

                                        let names =
                                            model.declarations
                                            |> List.filter (fun declaration ->
                                                declaration.kind = PdxShaderRuntime.EffectDeclaration
                                                && PdxShaderProject.canonicalizePath declaration.file = canonical)
                                            |> List.map (fun declaration -> declaration.name)
                                            |> List.distinctBy (fun name -> name.ToLowerInvariant())
                                            |> List.sort

                                        let page = names |> List.skip (min cursor names.Length) |> List.truncate limit

                                        let effects =
                                            page
                                            |> List.choose (fun name -> PdxShaderRuntime.effectReachability model name)
                                            |> List.map (shaderEffectJson model)
                                            |> Array.ofList

                                        Some(
                                            JsonValue.Record
                                                [| "ok", JsonValue.Boolean true
                                                   "file", JsonValue.String(filePath.Replace('\\', '/'))
                                                   "totalCount", JsonValue.Number(decimal names.Length)
                                                   "returnedCount", JsonValue.Number(decimal effects.Length)
                                                   "nextCursor",
                                                   (if cursor + effects.Length < names.Length then
                                                        JsonValue.Number(decimal (cursor + effects.Length))
                                                    else
                                                        JsonValue.Null)
                                                   "effects", JsonValue.Array effects |]
                                        )

                        // - cwtools.ai.shader.validate -
                        // Compile-unit (CWFX) diagnostics for one shader file, structured.
                        | { command = "cwtools.ai.shader.validate"
                            arguments = args } ->
                            let fields = shaderArgsRecord args
                            let operation = "cwtools.ai.shader.validate"

                            match shaderStringProperty "uri" fields with
                            | None -> Some(shaderErrorJson operation "uri" "uri is required.")
                            | Some uriText ->
                                match shaderPathFromUri operation uriText with
                                | Choice2Of2 error -> Some error
                                | Choice1Of2 filePath ->
                                    let canonical = PdxShaderProject.canonicalizePath filePath

                                    let resourceText =
                                        game.AllFiles()
                                        |> Seq.tryPick (function
                                            | FileWithContentResource(_, resource) when
                                                PdxShaderFeatures.isShaderFile resource.filepath
                                                && PdxShaderProject.canonicalizePath resource.filepath = canonical
                                                ->
                                                Some resource.filetext
                                            | _ -> None)

                                    let text =
                                        match docs.GetTextByPath filePath with
                                        | Some openText -> Some openText
                                        | None ->
                                            match resourceText with
                                            | Some resourceContent -> Some resourceContent
                                            | None ->
                                                try
                                                    Some(File.ReadAllText filePath)
                                                with _ ->
                                                    None

                                    match text with
                                    | None ->
                                        Some(
                                            shaderErrorJson
                                                operation
                                                uriText
                                                "no text available for the shader file (not open, not a content resource, not readable on disk)."
                                        )
                                    | Some fileText ->
                                        let diagnostics =
                                            PdxShaderFeatures.validateFromResources (game.AllFiles()) filePath fileText

                                        let severityName (severity: Severity) =
                                            match severity with
                                            | Severity.Error -> "error"
                                            | Severity.Warning -> "warning"
                                            | Severity.Information -> "info"
                                            | _ -> "hint"

                                        let diagnosticJson (error: CWError) =
                                            JsonValue.Record
                                                [| "code", JsonValue.String error.code
                                                   "severity", JsonValue.String(severityName error.severity)
                                                   "message", JsonValue.String error.message
                                                   "range", locationToJson error.range |]

                                        Some(
                                            JsonValue.Record
                                                [| "ok", JsonValue.Boolean true
                                                   "file", JsonValue.String(filePath.Replace('\\', '/'))
                                                   "count", JsonValue.Number(decimal diagnostics.Length)
                                                   "diagnostics",
                                                   JsonValue.Array(diagnostics |> List.map diagnosticJson |> Array.ofList) |]
                                        )

                        // - cwtools.ai.shader.preflightEdit -
                        // Host-only, fail-closed safety policy for exact proposed Shader
                        // text and interface effectFile edits. It is intentionally not a
                        // model-visible tool: every file write invokes it automatically.
                        | { command = "cwtools.ai.shader.preflightEdit"
                            arguments = args } ->
                            let fields = shaderArgsRecord args
                            let operation = "cwtools.ai.shader.preflightEdit"

                            match
                                shaderStringProperty "uri" fields,
                                shaderRawStringProperty "previousText" fields,
                                shaderRawStringProperty "text" fields
                            with
                            | Some uriText, Some previousText, Some proposedText ->
                                if previousText.Length > 4_000_000 || proposedText.Length > 4_000_000 then
                                    Some(shaderErrorJson operation uriText "shader preflight payload exceeds the 4,000,000 character safety limit.")
                                else
                                    match shaderEditPathFromUri operation uriText with
                                    | Choice2Of2 error -> Some error
                                    | Choice1Of2 filePath ->
                                        let replaceOpenDocument text =
                                            (filePath, text)
                                            :: (openShaderScriptDocuments ()
                                                |> List.filter (fun (path, _) -> not (PdxShaderProject.sameFilePath path filePath)))

                                        let issues = ResizeArray<string>()
                                        let mutable diagnosticsJson = JsonValue.Array [||]
                                        let mutable removedEffects: string list = []
                                        let mutable addedEffects: string list = []
                                        let mutable compileRoot: string option = None
                                        let mutable compileMemberCount = 0
                                        let mutable rendererSubtypes: string list = []
                                        let isShader = PdxShaderFeatures.isShaderFile filePath

                                        if isShader then
                                            let effectNames text =
                                                PdxShaderProject.createSnapshot
                                                    PdxShaderProject.CurrentDocument
                                                    filePath
                                                    filePath
                                                    text
                                                |> PdxShaderRuntime.declarationsFromSnapshot
                                                |> List.filter (fun declaration -> declaration.kind = PdxShaderRuntime.EffectDeclaration)
                                                |> List.map _.name
                                                |> List.distinctBy (fun name -> name.ToLowerInvariant())

                                            let beforeNames = effectNames previousText
                                            let afterNames = effectNames proposedText
                                            let beforeKeys = beforeNames |> List.map (fun name -> name.ToLowerInvariant()) |> Set.ofList
                                            let afterKeys = afterNames |> List.map (fun name -> name.ToLowerInvariant()) |> Set.ofList
                                            removedEffects <- beforeNames |> List.filter (fun name -> not (afterKeys.Contains(name.ToLowerInvariant())))
                                            addedEffects <- afterNames |> List.filter (fun name -> not (beforeKeys.Contains(name.ToLowerInvariant())))

                                            let model = shaderRuntimeModel ()
                                            for effectName in removedEffects do
                                                let policyReason =
                                                    match PdxShaderRuntime.renamePolicy model effectName with
                                                    | PdxShaderRuntime.RenameAllowed reason ->
                                                        sprintf "%s; a declaration-only write still cannot prove that every caller is updated atomically" reason
                                                    | PdxShaderRuntime.RenameRequiresExplicitForce reason -> reason
                                                    | PdxShaderRuntime.RenameDenied reason -> reason

                                                issues.Add(sprintf "Effect '%s' was removed or renamed: %s." effectName policyReason)

                                            let diagnostics =
                                                PdxShaderFeatures.validateFromResources (game.AllFiles()) filePath proposedText

                                            let diagnosticJson (error: CWError) =
                                                let severity =
                                                    match error.severity with
                                                    | Severity.Error -> "error"
                                                    | Severity.Warning -> "warning"
                                                    | Severity.Information -> "info"
                                                    | _ -> "hint"

                                                JsonValue.Record
                                                    [| "code", JsonValue.String error.code
                                                       "severity", JsonValue.String severity
                                                       "message", JsonValue.String error.message
                                                       "range", locationToJson error.range |]

                                            diagnosticsJson <- JsonValue.Array(diagnostics |> List.map diagnosticJson |> Array.ofList)

                                            let errors = diagnostics |> List.filter (fun diagnostic -> diagnostic.severity = Severity.Error)
                                            for diagnostic in errors do
                                                issues.Add(sprintf "%s: %s" diagnostic.code diagnostic.message)

                                            match PdxShaderRuntime.compileUnitFor (game.AllFiles()) (replaceOpenDocument proposedText) filePath with
                                            | None -> issues.Add("The proposed document could not be resolved to a shader compile unit.")
                                            | Some (unit, _) ->
                                                compileRoot <- Some unit.root.displayPath
                                                compileMemberCount <- unit.effective.Length
                                                for problem in unit.problems do
                                                    issues.Add(sprintf "Compile-unit include problem: %A" problem)

                                            let semantic =
                                                PdxShaderProject.createSnapshot
                                                    PdxShaderProject.CurrentDocument
                                                    filePath
                                                    filePath
                                                    proposedText
                                                |> PdxShaderProject.semanticSnapshot

                                            if PdxShaderPreprocessor.defaultPlatformVariants.IsEmpty then
                                                issues.Add("No platform macro profiles are available for variant analysis.")
                                            else
                                                semantic.preprocessor.regions
                                                |> List.map _.condition
                                                |> PdxShaderPreprocessor.compareVariants PdxShaderPreprocessor.defaultPlatformVariants
                                                |> ignore
                                        else
                                            // Structured runtime extraction compares effectFile selections;
                                            // no text regex is used to make a safety decision.
                                            let shaderGameVersion = if activeGame = STL then stlGameVersion else None
                                            let beforeModel =
                                                PdxShaderRuntime.buildModel shaderGameVersion (game.AllFiles()) (replaceOpenDocument previousText)
                                            let afterModel =
                                                PdxShaderRuntime.buildModel shaderGameVersion (game.AllFiles()) (replaceOpenDocument proposedText)
                                            let selections (model: PdxShaderRuntime.ShaderRuntimeModel) =
                                                model.evidence
                                                |> List.filter (fun evidence ->
                                                    evidence.kind = PdxShaderRuntime.EffectFileSelection
                                                    && PdxShaderProject.sameFilePath evidence.sourceFile filePath)
                                                |> List.map _.value
                                                |> List.distinct
                                                |> List.sort

                                            let beforeSelections = selections beforeModel
                                            let afterSelections = selections afterModel
                                            addedEffects <- afterSelections |> List.except beforeSelections
                                            removedEffects <- beforeSelections |> List.except afterSelections
                                            rendererSubtypes <-
                                                afterModel.interfaceSprites
                                                |> List.filter (fun sprite -> PdxShaderProject.sameFilePath sprite.sourceFile filePath)
                                                |> List.map _.rendererSubtype
                                                |> List.distinct
                                                |> List.sort

                                            if beforeSelections <> afterSelections then
                                                let resolvedTargets =
                                                    afterModel.effects
                                                    |> List.filter (fun effect ->
                                                        effect.allEvidence
                                                        |> List.exists (fun evidence ->
                                                            evidence.kind = PdxShaderRuntime.EffectFileSelection
                                                            && PdxShaderProject.sameFilePath evidence.sourceFile filePath))

                                                if resolvedTargets.IsEmpty && not afterSelections.IsEmpty then
                                                    issues.Add("The new effectFile selection does not resolve to a known effective shader file.")

                                                if not removedEffects.IsEmpty && afterSelections.IsEmpty then
                                                    issues.Add("effectFile was removed; the renderer would lose its versioned Shader contract.")

                                                afterModel.interfaceSprites
                                                |> List.filter (fun sprite -> PdxShaderProject.sameFilePath sprite.sourceFile filePath)
                                                |> List.collect (PdxShaderRuntime.validateRendererInvocation afterModel)
                                                |> List.iter issues.Add

                                        let issueList = issues |> Seq.distinct |> Seq.toList

                                        Some(
                                            JsonValue.Record
                                                [| "ok", JsonValue.Boolean true
                                                   "allowed", JsonValue.Boolean issueList.IsEmpty
                                                   "file", JsonValue.String(filePath.Replace('\\', '/'))
                                                   "targetKind", JsonValue.String(if isShader then "shader" else "interface_gfx")
                                                   "issues", JsonValue.Array(issueList |> List.map JsonValue.String |> Array.ofList)
                                                   "removed", JsonValue.Array(removedEffects |> List.map JsonValue.String |> Array.ofList)
                                                   "added", JsonValue.Array(addedEffects |> List.map JsonValue.String |> Array.ofList)
                                                   "compileRoot", compileRoot |> Option.map (fun path -> JsonValue.String(path.Replace('\\', '/'))) |> Option.defaultValue JsonValue.Null
                                                   "compileMemberCount", JsonValue.Number(decimal compileMemberCount)
                                                   "platformProfileCount", JsonValue.Number(decimal PdxShaderPreprocessor.defaultPlatformVariants.Length)
                                                   "rendererSubtypes", JsonValue.Array(rendererSubtypes |> List.map JsonValue.String |> Array.ofList)
                                                   "diagnostics", diagnosticsJson |]
                                        )
                            | _ ->
                                Some(shaderErrorJson operation "arguments" "uri, previousText and text are required string fields.")

                        // - cwtools.ai.shader.compareVanilla -
                        // Effective vs overridden vanilla declarations, by effect name or file.
                        | { command = "cwtools.ai.shader.compareVanilla"
                            arguments = args } ->
                            let fields = shaderArgsRecord args
                            let operation = "cwtools.ai.shader.compareVanilla"

                            let comparisonJson (comparison: PdxShaderRuntime.VanillaComparison) =
                                JsonValue.Record
                                    [| "name", JsonValue.String comparison.name
                                       "effective",
                                       JsonValue.Array(comparison.effective |> List.map shaderDeclarationJson |> Array.ofList)
                                       "overriddenVanilla",
                                       JsonValue.Array(comparison.overriddenVanilla |> List.map shaderDeclarationJson |> Array.ofList) |]

                            match shaderStringProperty "effectName" fields, shaderStringProperty "uri" fields with
                            | None, None -> Some(shaderErrorJson operation "effectName" "effectName or uri is required.")
                            | Some effectName, _ ->
                                let model = shaderRuntimeModel ()

                                Some(
                                    JsonValue.Record
                                        [| "ok", JsonValue.Boolean true
                                           "comparison", comparisonJson (PdxShaderRuntime.compareWithVanilla model effectName) |]
                                )
                            | None, Some uriText ->
                                match shaderPathFromUri operation uriText with
                                | Choice2Of2 error -> Some error
                                | Choice1Of2 filePath ->
                                    let model = shaderRuntimeModel ()
                                    let canonical = PdxShaderProject.canonicalizePath filePath

                                    let comparisons =
                                        model.declarations
                                        |> List.filter (fun declaration ->
                                            declaration.kind = PdxShaderRuntime.EffectDeclaration
                                            && PdxShaderProject.canonicalizePath declaration.file = canonical)
                                        |> List.map (fun declaration -> declaration.name)
                                        |> List.distinctBy (fun name -> name.ToLowerInvariant())
                                        |> List.sort
                                        |> List.map (fun name -> comparisonJson (PdxShaderRuntime.compareWithVanilla model name))
                                        |> Array.ofList

                                    Some(
                                        JsonValue.Record
                                            [| "ok", JsonValue.Boolean true
                                               "file", JsonValue.String(filePath.Replace('\\', '/'))
                                               "comparisons", JsonValue.Array comparisons |]
                                    )

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

                            let text = String.Join("\r\n", keys)

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

                            let text = String.Join("\r\n", keys)

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

                            let text = String.Join("\r\n", texts)

                            client.CustomNotification(
                                "createVirtualFile",
                                JsonValue.Record
                                    [| "uri", JsonValue.String("cwtools://errors.csv")
                                       "fileContent", JsonValue.String(text) |]
                            )

                            None
                        | { command = "reloadrulesconfig"
                            arguments = _ } ->
                            semanticCatalogCache <- None
                            let configs = getConfigFiles cachePath useManualRules manualRulesFolder bundledRulesPath preferBundledRules
                            game.ReplaceConfigRules configs
                            bumpGameModelEpoch ()
                            bumpRulesModelEpoch ()
                            fileDiagnosticStates.Keys
                            |> Seq.toArray
                            |> Array.iter markFilePendingGlobalRevalidation
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

                            let text = String.Join("\r\n", text)

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
                            let text = String.Join("\r\n", locs)

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
                                let header = "type,name,file,line" + "\r\n"

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
                                    |> String.concat "\r\n"

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
                            let eventTargetNameAtPosition =
                                let lines = fileContent.Replace("\r\n", "\n").Split('\n')

                                if line < 0 || line >= lines.Length then
                                    None
                                else
                                    let matches =
                                        System.Text.RegularExpressions.Regex.Matches(
                                            lines.[line],
                                            @"event_target:([A-Za-z_][A-Za-z0-9_.-]*)\??"
                                        )
                                        |> Seq.cast<System.Text.RegularExpressions.Match>
                                        |> Seq.toArray

                                    matches
                                    |> Array.tryFind (fun m -> col >= m.Index && col <= m.Index + m.Length)
                                    |> Option.orElseWith (fun () -> if matches.Length = 1 then Some matches.[0] else None)
                                    |> Option.map (fun m -> m.Groups.[1].Value)
                            let scopeResult =
                                match gameObj with
                                | Some g ->
                                    let eventTarget =
                                        eventTargetNameAtPosition
                                        |> Option.map (fun name ->
                                            let saved =
                                                match activeGame, stlGameObj with
                                                | STL, Some stellaris ->
                                                    stellaris.References().SavedScopes
                                                    |> Seq.filter (fun (savedName, _, _) ->
                                                        String.Equals(savedName, name, StringComparison.OrdinalIgnoreCase))
                                                    |> Seq.toArray
                                                | _ -> [||]

                                            let alternatives =
                                                saved
                                                |> Array.map (fun (_, _, scope) -> scope.ToString())
                                                |> Array.distinct
                                                |> Array.sort

                                            let certainty, resolvedScope, warnings =
                                                match alternatives with
                                                | [||] ->
                                                    "unresolved",
                                                    "unknown",
                                                    [| JsonValue.String "No saved scope was found for this event target." |]
                                                | [| exact |] -> "project_unique", exact, [||]
                                                | many ->
                                                    "ambiguous",
                                                    "unknown",
                                                    [| JsonValue.String(
                                                           sprintf
                                                               "This event target is saved with multiple scopes: %s"
                                                               (String.concat ", " many)
                                                       ) |]

                                            let definitions =
                                                saved
                                                |> Array.truncate 32
                                                |> Array.map (fun (_, targetRange, scope) ->
                                                    JsonValue.Record
                                                        [| "scope", JsonValue.String(scope.ToString())
                                                           "file", JsonValue.String(targetRange.FileName.Replace('\\', '/'))
                                                           "line", JsonValue.Number(decimal targetRange.StartLine)
                                                           "col", JsonValue.Number(decimal (int targetRange.StartColumn)) |])

                                            JsonValue.Record
                                                [| "name", JsonValue.String name
                                                   "scope", JsonValue.String resolvedScope
                                                   "alternatives", JsonValue.Array(alternatives |> Array.map JsonValue.String)
                                                   "certainty", JsonValue.String certainty
                                                   "definitions", JsonValue.Array definitions
                                                   "warnings", JsonValue.Array warnings |])
                                        |> Option.defaultValue JsonValue.Null

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
                                        let scopeInference =
                                            match g with
                                            | :? IScopeInferenceProvider as provider ->
                                                provider.ScopeInferenceAtPos position filePath fileContent scopes
                                                |> Option.map (fun inference ->
                                                    JsonValue.Record
                                                        [| "kind", JsonValue.String inference.kind
                                                           "candidates", JsonValue.Array(inference.candidates |> List.map JsonValue.String |> List.toArray)
                                                           "resolvedScope", JsonValue.String inference.resolvedScope
                                                           "certainty", JsonValue.String inference.certainty
                                                           "evidence", JsonValue.Array(inference.evidence |> List.map JsonValue.String |> List.toArray) |])
                                                |> Option.defaultValue JsonValue.Null
                                            | _ -> JsonValue.Null
                                        JsonValue.Record
                                            [| "thisScope",  JsonValue.String thisScopeStr
                                               "root",       JsonValue.String (scopes.Root.ToString())
                                               "currentScope", JsonValue.String thisScopeStr
                                               "prevChain",  JsonValue.Array(prevChain |> Array.map JsonValue.String)
                                               "fromChain",  JsonValue.Array(fromChain |> Array.map JsonValue.String)
                                               "eventTarget", eventTarget
                                               "scopeInference", scopeInference
                                               "ok",         JsonValue.Boolean true |]
                                    | None ->
                                        JsonValue.Record
                                            [| "thisScope", JsonValue.String "unknown"
                                               "root",      JsonValue.String "unknown"
                                               "currentScope", JsonValue.String "unknown"
                                               "prevChain", JsonValue.Array [||]
                                               "fromChain", JsonValue.Array [||]
                                               "eventTarget", eventTarget
                                               "scopeInference", JsonValue.Null
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
                        // Find where a named symbol is defined, preferring the active
                        // CWTools TypeDef index before scanning untyped top-level keys.
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
                            // Optional second argument narrows the lookup to concrete CWT
                            // entity types. This prevents any same-named definition from
                            // another active TypeDef being accepted as typed proof.
                            let expectedTypes =
                                args
                                |> List.tryItem 1
                                |> Option.map (function
                                    | JsonValue.Array values ->
                                        values
                                        |> Array.choose (function
                                            | JsonValue.String value when value.Trim() <> "" ->
                                                Some(value.Trim().ToLowerInvariant())
                                            | _ -> None)
                                        |> Set.ofArray
                                    | JsonValue.String value when value.Trim() <> "" ->
                                        Set.singleton (value.Trim().ToLowerInvariant())
                                    | _ -> Set.empty)
                                |> Option.defaultValue Set.empty
                            let result =
                                match symbolName with
                                | None ->
                                    JsonValue.Record
                                        [| "ok",    JsonValue.Boolean false
                                           "error", JsonValue.String "symbolName is required. Provide the exact identifier obtained from current project or TypeDef evidence." |]
                                | Some name ->
                                    // Phase 1: Fast lookup via Types() index (O(1) per type category)
                                    let tryFindInTypes (g: IGame) =
                                        g.Types()
                                        |> Map.toSeq
                                        |> Seq.tryPick (fun (typeName, instances) ->
                                            let normalizedType = typeName.ToLowerInvariant()
                                            if not expectedTypes.IsEmpty && not (expectedTypes.Contains normalizedType) then
                                                None
                                            else
                                                instances
                                                |> Array.tryFind (fun td ->
                                                    String.Equals(td.id, name, StringComparison.OrdinalIgnoreCase))
                                                |> Option.map (fun td ->
                                                    JsonValue.Record
                                                        [| "name",   JsonValue.String name
                                                           "type",   JsonValue.String typeName
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
                                            if expectedTypes.IsEmpty then
                                                let visitor =
                                                    { new IGameVisitor<_> with
                                                        member this.Visit game = tryFindInGame game }
                                                gameDispatcher.Dispatch visitor |> Option.flatten
                                            else
                                                None
                                        )
                                    match found with
                                    | Some json -> json
                                    | None ->
                                        match gameObj with
                                        | None ->
                                            JsonValue.Record [| "ok", JsonValue.Boolean false; "error", JsonValue.String "LSP server not ready" |]
                                        | Some _ ->
                                            let expectedTypeList =
                                                expectedTypes
                                                |> Seq.toList
                                                |> String.concat ", "
                                            let expectedHint =
                                                if expectedTypes.IsEmpty then ""
                                                else $" with expected type [{expectedTypeList}]"
                                            JsonValue.Record
                                                [| "ok",    JsonValue.Boolean false
                                                   "error", JsonValue.String $"Symbol '{name}' was not found{expectedHint}. Enumerate the current TypeDef with query_types or inspect its CWT schema before retrying." |]
                            Some result

                        // - cwtools.ai.exploreProject -
                        // Bounded semantic graph over CWTools' existing typed indexes and
                        // ComputedData. The server remains the only source of PDX/CWT truth;
                        // MCP and the extension are thin consumers of this command.
                        | { command = "cwtools.ai.exploreProject"
                            arguments = args } ->
                            let stringArg index =
                                args
                                |> List.tryItem index
                                |> Option.bind (function
                                    | JsonValue.String value when not (String.IsNullOrWhiteSpace value) -> Some value
                                    | _ -> None)
                            let boolArg index fallback =
                                args
                                |> List.tryItem index
                                |> Option.bind (function JsonValue.Boolean value -> Some value | _ -> None)
                                |> Option.defaultValue fallback
                            let intArg index fallback =
                                args
                                |> List.tryItem index
                                |> Option.bind (fun value ->
                                    try Some(value.AsInteger())
                                    with _ -> None)
                                |> Option.defaultValue fallback
                            let query = stringArg 0 |> Option.defaultValue ""
                            let file =
                                stringArg 1
                                |> Option.map (fun value ->
                                    if value.StartsWith("file:", StringComparison.OrdinalIgnoreCase) then
                                        try getPathFromDoc (Uri(value))
                                        with _ -> value
                                    else value)
                            let typeName = stringArg 2
                            let options: ExploreOptions =
                                { query = query
                                  file = file
                                  typeName = typeName
                                  exact = boolArg 3 false
                                  depth = intArg 4 1
                                  maxNodes = intArg 5 30
                                  maxEdges = intArg 6 80
                                  includeMetadata = boolArg 7 true }

                            if String.IsNullOrWhiteSpace query && file.IsNone && typeName.IsNone then
                                Some(
                                    JsonValue.Record
                                        [| "ok", JsonValue.Boolean false
                                           "status", JsonValue.String "error"
                                           "error", JsonValue.String "exploreProject requires query, file, or typeName." |])
                            else
                                // Query a coherent model snapshot. UpdateFile, incremental type
                                // commits, deletes, and RefreshCaches all hold the matching write lock.
                                // LanguageServer already executes this read-only command under the
                                // matching read lock; acquiring it again would throw LockRecursionException.
                                let validation = validationRuntimeSnapshot ()
                                let loading = loadingRuntimeSnapshot ()
                                let pendingKinds = pendingRefreshDomainList ()
                                let status =
                                    if loading.inProgress then "loading"
                                    elif validation.inProgress || not pendingKinds.IsEmpty then "stale"
                                    else "ready"
                                let runtime: RuntimeMetadata =
                                    { graphVersion = diagnosticEpoch.Value
                                      status = status
                                      validationInProgress = validation.inProgress
                                      loadingInProgress = loading.inProgress
                                      pendingGlobalKinds = pendingKinds
                                      lastGlobalRefreshAtUnixMs = dateTimeToUnixMs lastGlobalRefreshAt }
                                let visitor =
                                    { new IGameVisitor<JsonValue> with
                                        member _.Visit game = exploreProject game options runtime }
                                match gameDispatcher.Dispatch visitor with
                                | Some result -> Some result
                                | None ->
                                    Some(
                                        JsonValue.Record
                                            [| "ok", JsonValue.Boolean false
                                               "status", JsonValue.String "unavailable"
                                               "error", JsonValue.String "LSP server has not loaded a game model yet." |])

                        // - cwtools.ai.queryLocalisationAudit -
                        // Authoritative missing-reference and command/scope audit
                        // from the active CWTools localisation validator.
                        | { command = "cwtools.ai.queryLocalisationAudit"
                            arguments = args } ->
                            let fields = args |> List.tryHead |> Option.bind (function JsonValue.Record value -> Some value | _ -> None) |> Option.defaultValue [||]
                            let field name = fields |> Array.tryPick (fun (key, value) -> if key = name then Some value else None)
                            let stringField name = field name |> Option.bind (function JsonValue.String value when not (String.IsNullOrWhiteSpace value) -> Some value | _ -> None)
                            let boolField name fallback = field name |> Option.bind (function JsonValue.Boolean value -> Some value | _ -> None) |> Option.defaultValue fallback
                            let limit = field "limit" |> Option.bind (function JsonValue.Number value -> Some(int value) | JsonValue.Float value -> Some(int value) | _ -> None) |> Option.defaultValue 100 |> max 1 |> min 500
                            let query = stringField "key"
                            let prefix = boolField "prefix" false
                            let contains = boolField "contains" false
                            let caseSensitive = boolField "caseSensitive" false
                            let comparison = if caseSensitive then StringComparison.Ordinal else StringComparison.OrdinalIgnoreCase
                            let matches (value: string) =
                                query
                                |> Option.forall (fun expected ->
                                    if prefix then value.StartsWith(expected, comparison)
                                    elif contains then value.Contains(expected, comparison)
                                    else value.Equals(expected, comparison))
                            let visitor =
                                { new IGameVisitor<JsonValue> with
                                    member _.Visit game =
                                        let errors =
                                            game.LocalisationErrors(true, true)
                                            |> List.filter (fun error -> error.code.StartsWith("CW1", StringComparison.Ordinal) || error.code.StartsWith("CW2", StringComparison.Ordinal))
                                            |> List.filter (fun error -> error.data |> Option.forall matches)
                                            |> List.sortBy (fun error -> error.range.FileName, error.range.StartLine, error.code)
                                        let selected = errors |> List.truncate limit
                                        let issueJson error =
                                            let key = error.data |> Option.defaultValue ""
                                            let normalizedFile = error.range.FileName.Replace('\\', '/')
                                            let inlineTemplate =
                                                let marker = "/common/inline_scripts/"
                                                let lower = normalizedFile.ToLowerInvariant()
                                                let index = lower.IndexOf(marker, StringComparison.Ordinal)
                                                if index >= 0 then
                                                    let relative = normalizedFile.Substring(index + marker.Length)
                                                    Some(if relative.EndsWith(".txt", StringComparison.OrdinalIgnoreCase) then relative.Substring(0, relative.Length - 4) else relative)
                                                else None
                                            JsonValue.Record
                                                [| "code", JsonValue.String error.code
                                                   "key", JsonValue.String key
                                                   "file", JsonValue.String normalizedFile
                                                   "line", JsonValue.Number(decimal (int error.range.StartLine))
                                                   "message", JsonValue.String error.message
                                                   "dynamic", JsonValue.Boolean(key.Contains("$", StringComparison.Ordinal))
                                                   "inlineTemplate", (inlineTemplate |> Option.map JsonValue.String |> Option.defaultValue JsonValue.Null) |]
                                        JsonValue.Record
                                            [| "ok", JsonValue.Boolean true
                                               "source", JsonValue.String "cwtools-localisation-validator"
                                               "version", JsonValue.Number 3m
                                               "issues", JsonValue.Array(selected |> List.map issueJson |> List.toArray)
                                               "coverage", JsonValue.Record
                                                   [| "issuesConsidered", JsonValue.Number(decimal errors.Length)
                                                      "issuesIndexed", JsonValue.Number(decimal selected.Length)
                                                      "truncated", JsonValue.Boolean(errors.Length > selected.Length)
                                                      "staleReasons", JsonValue.Array [||] |] |] }
                            match gameDispatcher.Dispatch visitor with
                            | Some result -> Some result
                            | None -> Some(JsonValue.Record [| "ok", JsonValue.Boolean false; "status", JsonValue.String "unavailable"; "error", JsonValue.String "LSP server has not loaded a game model yet." |])

                        // - cwtools.ai.compareDefinitionWithVanilla -
                        // Field-level diff of a workspace definition against its
                        // vanilla counterpart. Accepts exact entityType + symbolId.
                        | { command = "cwtools.ai.compareDefinitionWithVanilla"
                            arguments = args } ->
                            let stringArg index =
                                args
                                |> List.tryItem index
                                |> Option.bind (function
                                    | JsonValue.String value when not (String.IsNullOrWhiteSpace value) -> Some value
                                    | _ -> None)
                            match stringArg 0, stringArg 1 with
                            | None, _ | _, None ->
                                Some(
                                    JsonValue.Record
                                        [| "ok", JsonValue.Boolean false
                                           "status", JsonValue.String "error"
                                           "error", JsonValue.String "compareDefinitionWithVanilla requires entityType and symbolId." |])
                            | Some entityType, Some symbolId ->
                                let visitor =
                                    { new IGameVisitor<JsonValue> with
                                        member _.Visit game =
                                            let freshness, staleReasons = analysisFreshnessSnapshot ()
                                            SemanticGraph.compareDefinitionWithVanillaWithRuntime
                                                (fun () -> cancellationToken.IsCancellationRequested)
                                                freshness staleReasons game entityType symbolId }
                                match gameDispatcher.Dispatch visitor with
                                | Some result -> Some result
                                | None ->
                                    Some(
                                        JsonValue.Record
                                            [| "ok", JsonValue.Boolean false
                                               "status", JsonValue.String "unavailable"
                                               "error", JsonValue.String "LSP server has not loaded a game model yet." |])

                        // - cwtools.ai.analyzePdxFlow -
                        // Static cost model and gameplay relations for a file,
                        // definition or identifier. Bounded, read-only, never
                        // predicts real runtime.
                        | { command = "cwtools.ai.analyzePdxFlow"
                            arguments = args } ->
                            let fields = args |> List.tryHead |> Option.bind (function JsonValue.Record value -> Some value | _ -> None) |> Option.defaultValue [||]
                            let field name = fields |> Array.tryPick (fun (key, value) -> if key = name then Some value else None)
                            let stringField name = field name |> Option.bind (function JsonValue.String value when not (String.IsNullOrWhiteSpace value) -> Some value | _ -> None)
                            let legacyString index = args |> List.tryItem index |> Option.bind (function JsonValue.String value when not (String.IsNullOrWhiteSpace value) -> Some value | _ -> None)
                            let query: PdxFlowAnalysis.FlowQuery =
                                { file = stringField "file" |> Option.orElseWith (fun () -> legacyString 0)
                                  definitionId = stringField "definitionId" |> Option.orElseWith (fun () -> legacyString 1)
                                  entityType = stringField "entityType"
                                  limit = field "limit" |> Option.bind (function JsonValue.Number value -> Some(int value) | JsonValue.Float value -> Some(int value) | _ -> None) |> Option.defaultValue 100 }
                            if query.file.IsNone && query.definitionId.IsNone && query.entityType.IsNone then
                                Some(
                                    JsonValue.Record
                                        [| "ok", JsonValue.Boolean false
                                           "status", JsonValue.String "error"
                                           "error", JsonValue.String "analyzePdxFlow requires file, definitionId, or entityType." |])
                            else
                                let visitor =
                                    { new IGameVisitor<JsonValue> with
                                        member _.Visit game =
                                            let freshness, staleReasons = analysisFreshnessSnapshot ()
                                            PdxFlowAnalysis.flowAnalysisJsonWithFreshness
                                                (PdxFlowAnalysis.analyzePdxFlowCancellable (fun () -> cancellationToken.IsCancellationRequested) game query)
                                                freshness staleReasons }
                                match gameDispatcher.Dispatch visitor with
                                | Some result -> Some result
                                | None ->
                                    Some(
                                        JsonValue.Record
                                            [| "ok", JsonValue.Boolean false
                                               "status", JsonValue.String "unavailable"
                                               "error", JsonValue.String "LSP server has not loaded a game model yet." |])

                        // - cwtools.ai.exploreInlineGraph -
                        // Read-only inline-script instantiation graph: templates,
                        // parameters, invocations, arguments, expansions and
                        // structured parameter problems. Bounded and deterministic.
                        | { command = "cwtools.ai.exploreInlineGraph"
                            arguments = args } ->
                            let optionFields =
                                args
                                |> List.tryHead
                                |> Option.bind (function JsonValue.Record fields -> Some fields | _ -> None)
                                |> Option.defaultValue [||]
                            let tryField name =
                                optionFields
                                |> Array.tryPick (fun (key, value) -> if key = name then Some value else None)
                            let stringField name =
                                tryField name
                                |> Option.bind (function JsonValue.String value when not (String.IsNullOrWhiteSpace value) -> Some value | _ -> None)
                            let intField name fallback =
                                tryField name
                                |> Option.bind (function JsonValue.Number value -> Some(int value) | JsonValue.Float value -> Some(int value) | _ -> None)
                                |> Option.defaultValue fallback
                            let legacyFile =
                                args
                                |> List.tryHead
                                |> Option.bind (function JsonValue.String value when not (String.IsNullOrWhiteSpace value) -> Some value | _ -> None)
                            let query: InlineGraph.InlineGraphQuery =
                                { template = stringField "template"
                                  callerFile = stringField "file" |> Option.orElse legacyFile
                                  callerLine = tryField "line" |> Option.bind (function JsonValue.Number value -> Some(int value) | JsonValue.Float value -> Some(int value) | _ -> None)
                                  limit = intField "limit" 50 }
                            let visitor =
                                { new IGameVisitor<JsonValue> with
                                    member _.Visit game =
                                        let freshness, staleReasons = analysisFreshnessSnapshot ()
                                        let facts = InlineGraph.collectInlineGraphCancellable (fun () -> cancellationToken.IsCancellationRequested) (game.AllEntities())
                                        let filtered, truncated, considered = InlineGraph.filterInlineGraph query facts
                                        InlineGraph.inlineGraphJsonWithCoverageAndFreshness filtered truncated considered freshness staleReasons }
                            match gameDispatcher.Dispatch visitor with
                            | Some result -> Some result
                            | None ->
                                Some(
                                    JsonValue.Record
                                        [| "ok", JsonValue.Boolean false
                                           "status", JsonValue.String "unavailable"
                                           "error", JsonValue.String "LSP server has not loaded a game model yet." |])

                        // - cwtools.ai.exportProjectKnowledge -
                        // Exports a bounded, provenance-rich snapshot for /init. The command
                        // reads the same coherent IGame model used by diagnostics/completion,
                        // so workspace definitions, embedded vanilla data, references, and
                        // active override modes cannot drift between separate tool calls.
                        | { command = "cwtools.ai.exportProjectKnowledge"
                            arguments = args } ->
                            let optionsRecord =
                                args
                                |> List.tryHead
                                |> Option.bind (function JsonValue.Record fields -> Some fields | _ -> None)
                                |> Option.defaultValue [||]
                            let tryProperty name =
                                optionsRecord
                                |> Array.tryPick (fun (key, value) -> if key = name then Some value else None)
                            let stringArray name =
                                match tryProperty name with
                                | Some (JsonValue.Array values) ->
                                    values
                                    |> Array.choose (function JsonValue.String value when not (String.IsNullOrWhiteSpace value) -> Some value | _ -> None)
                                    |> Array.toList
                                | _ -> []
                            let intProperty name fallback =
                                match tryProperty name with
                                | Some (JsonValue.Number value) -> int value
                                | _ -> fallback
                            let stringProperty name =
                                match tryProperty name with
                                | Some (JsonValue.String value) when not (String.IsNullOrWhiteSpace value) -> Some value
                                | _ -> None
                            let boolProperty name fallback =
                                match tryProperty name with
                                | Some (JsonValue.Boolean value) -> value
                                | _ -> fallback
                            let exportOptions: Main.ProjectKnowledge.ExportOptions =
                                { domains = stringArray "domains"
                                  changedFiles = stringArray "changedFiles"
                                  maxDefinitions = intProperty "maxDefinitions" 100000
                                  maxTopologyFiles = intProperty "maxTopologyFiles" 1200
                                  maxEdges = intProperty "maxEdges" 8000
                                  archetypesPerDomain = intProperty "archetypesPerDomain" 8
                                  completeExport = boolProperty "completeExport" false
                                  databasePath = stringProperty "databasePath"
                                  workspaceRoot = stringProperty "workspaceRoot"
                                  vanillaRoot = stringProperty "vanillaRoot"
                                  generationMode = stringProperty "generationMode" |> Option.defaultValue "full" }
                            let requireReady = boolProperty "requireReady" false
                            let projectRoots =
                                match workspaceFolders with
                                | folders when not folders.IsEmpty -> folders |> List.map (fun folder -> folder.uri.LocalPath)
                                | _ ->
                                    rootUri
                                    |> Option.map (fun uri -> uri.LocalPath)
                                    |> Option.toList
                            let gameName =
                                match activeGame with
                                | STL -> "stellaris"
                                | HOI4 -> "hoi4"
                                | EU4 -> "eu4"
                                | EU5 -> "eu5"
                                | CK2 -> "ck2"
                                | CK3 -> "ck3"
                                | IR -> "imperator"
                                | VIC2 -> "vic2"
                                | VIC3 -> "vic3"
                                | Custom -> "paradox"
                            // Incremental export only reads the coherent game model and uses a
                            // per-database gate, so the protocol may run it alongside editor reads.
                            // Full publication remains under the protocol write lock during load.
                            let validation = validationRuntimeSnapshot ()
                            let loading = loadingRuntimeSnapshot ()
                            let pendingKinds = pendingRefreshDomainList ()
                            let status =
                                if loading.inProgress then "loading"
                                elif validation.inProgress || not pendingKinds.IsEmpty then "stale"
                                else "ready"
                            let runtime: Main.ProjectKnowledge.RuntimeMetadata =
                                { graphVersion = diagnosticEpoch.Value
                                  status = status
                                  validationInProgress = validation.inProgress
                                  loadingInProgress = loading.inProgress
                                  pendingGlobalKinds = pendingKinds
                                  lastGlobalRefreshAtUnixMs = dateTimeToUnixMs lastGlobalRefreshAt }
                            if requireReady && status <> "ready" then
                                Some(
                                    JsonValue.Record
                                        [| "ok", JsonValue.Boolean false
                                           "status", JsonValue.String status
                                           "error", JsonValue.String $"CWTools project knowledge export is waiting for the {status} model to become ready." |])
                            else
                                let visitor =
                                    { new IGameVisitor<JsonValue> with
                                        member _.Visit game =
                                            Main.ProjectKnowledge.exportProjectKnowledgeCancellable
                                                (fun () -> cancellationToken.IsCancellationRequested)
                                                gameName projectRoots exportOptions runtime game }
                                try
                                    match gameDispatcher.Dispatch visitor with
                                    | Some result -> Some result
                                    | None ->
                                        Some(
                                            JsonValue.Record
                                                [| "ok", JsonValue.Boolean false
                                                   "status", JsonValue.String "unavailable"
                                                   "error", JsonValue.String "LSP server has not loaded a game model yet." |])
                                with error ->
                                    Some(
                                        JsonValue.Record
                                            [| "ok", JsonValue.Boolean false
                                               "status", JsonValue.String "error"
                                               "error", JsonValue.String error.Message |])

                        // - cwtools.ai.queryProjectKnowledgeDb -
                        | { command = "cwtools.ai.queryProjectKnowledgeDb"
                            arguments = args } ->
                            Some(queryProjectKnowledgeDbCommand args)

                        // - cwtools.ai.getSemanticCatalog -
                        // Returns only requested rule aliases plus all active CWTools type definitions.
                        | { command = "cwtools.ai.getSemanticCatalog"
                            arguments = rest } ->
                            let requestedNames =
                                rest
                                |> List.tryItem 0
                                |> Option.bind (function JsonValue.Array values -> Some values | _ -> None)
                                |> Option.map (fun values ->
                                    values
                                    |> Array.choose (function JsonValue.String name when not (String.IsNullOrWhiteSpace name) -> Some(name.ToLowerInvariant()) | _ -> None)
                                    |> Array.distinct
                                    |> Array.truncate 4000
                                    |> Array.toList)
                                |> Option.defaultValue []
                            let allRules, allDefinitionReferences, allShaderReferences, rulesHash, hasConfigs =
                                match semanticCatalogCache with
                                | Some cached -> cached
                                | None ->
                                    let configs = getConfigFiles cachePath useManualRules manualRulesFolder bundledRulesPath preferBundledRules
                                    let parsedRules, parsedHash = semanticRulesFromConfigs [] configs
                                    let parsedDefinitionReferences, parsedShaderReferences = semanticDefinitionReferencesFromConfigs configs
                                    semanticCatalogGeneration <- semanticCatalogGeneration + 1L
                                    let cached = parsedRules, parsedDefinitionReferences, parsedShaderReferences, parsedHash, not configs.IsEmpty
                                    semanticCatalogCache <- Some cached
                                    cached
                            let requested = System.Collections.Generic.HashSet<string>(requestedNames, StringComparer.OrdinalIgnoreCase)
                            let rules =
                                if requested.Count = 0 then allRules
                                else
                                    allRules
                                    |> List.filter (fun rule ->
                                        requested.Contains rule.name
                                        || (rule.name.StartsWith("<", StringComparison.Ordinal)
                                            && rule.name.EndsWith(">", StringComparison.Ordinal)))
                            let gameName =
                                match activeGame with
                                | STL -> "stellaris"
                                | HOI4 -> "hoi4"
                                | EU4 -> "eu4"
                                | EU5 -> "eu5"
                                | CK2 -> "ck2"
                                | CK3 -> "ck3"
                                | IR -> "imperator"
                                | VIC2 -> "vic2"
                                | VIC3 -> "vic3"
                                | Custom -> "paradox"
                            let visitor =
                                { new IGameVisitor<JsonValue> with
                                    member _.Visit game =
                                        let allTypeDefs =
                                            game.TypeDefs()
                                            |> List.sortBy (fun td -> td.name)
                                        let definitionTypes =
                                            allTypeDefs
                                            |> List.truncate 4000
                                            |> List.map (fun td ->
                                                let paths =
                                                    td.pathOptions.paths
                                                    |> Array.map (fun value ->
                                                        value.Replace('\\', '/').Trim().TrimStart('/').TrimEnd('/').Replace("game/", "", StringComparison.OrdinalIgnoreCase).ToLowerInvariant())
                                                    |> Array.filter (String.IsNullOrWhiteSpace >> not)
                                                    |> Array.distinct
                                                    |> Array.sort
                                                    |> Array.map JsonValue.String
                                                let typeKeyFilters =
                                                    let rootFilters =
                                                        match td.typeKeyFilter with
                                                        | Some(values, false) -> values
                                                        | _ -> []
                                                    let subtypeFilters =
                                                        td.subtypes |> List.choose (fun subtype -> subtype.typeKeyField)
                                                    rootFilters @ subtypeFilters
                                                    |> List.map (fun value -> value.Trim().Trim('"').ToLowerInvariant())
                                                    |> List.filter (String.IsNullOrWhiteSpace >> not)
                                                    |> List.distinct
                                                    |> List.sort
                                                    |> List.map JsonValue.String
                                                    |> List.toArray
                                                let fields = ResizeArray<string * JsonValue>()
                                                fields.Add("name", JsonValue.String(td.name.ToLowerInvariant()))
                                                fields.Add("paths", JsonValue.Array paths)
                                                td.nameField |> Option.iter (fun nameField -> fields.Add("nameField", JsonValue.String(nameField.ToLowerInvariant())))
                                                fields.Add("typeKeyFilters", JsonValue.Array typeKeyFilters)
                                                let valueReferences =
                                                    allDefinitionReferences
                                                    |> List.filter (fun item -> String.Equals(item.definitionName, td.name, StringComparison.OrdinalIgnoreCase))
                                                    |> List.map (fun item ->
                                                        JsonValue.Record
                                                            [| "argumentPath", JsonValue.String item.reference.argumentPath
                                                               "access", JsonValue.String item.reference.access
                                                               "typeName", JsonValue.String item.reference.typeName |])
                                                    |> List.truncate 512
                                                    |> List.toArray
                                                fields.Add("valueReferences", JsonValue.Array valueReferences)
                                                let shaderReferences =
                                                    allShaderReferences
                                                    |> List.filter (fun item -> String.Equals(item.definitionName, td.name, StringComparison.OrdinalIgnoreCase))
                                                    |> List.map (fun item ->
                                                        let referenceFields = ResizeArray<string * JsonValue>()
                                                        referenceFields.Add("argumentPath", JsonValue.String item.reference.argumentPath)
                                                        referenceFields.Add("referenceKind", JsonValue.String item.reference.referenceKind)
                                                        referenceFields.Add("dynamicValuePolicy", JsonValue.String item.reference.dynamicValuePolicy)
                                                        item.reference.pathPrefix
                                                        |> Option.iter (fun value -> referenceFields.Add("pathPrefix", JsonValue.String value))
                                                        item.reference.extension
                                                        |> Option.iter (fun value -> referenceFields.Add("extension", JsonValue.String value))
                                                        JsonValue.Record(referenceFields.ToArray()))
                                                    |> List.truncate 512
                                                    |> List.toArray
                                                fields.Add("shaderReferences", JsonValue.Array shaderReferences)
                                                JsonValue.Record(fields.ToArray()))
                                            |> List.toArray
                                        let directoryPaths =
                                            allTypeDefs
                                            |> Seq.map (fun td -> td.name, td.pathOptions.paths :> seq<string>)
                                            |> Catalog.build
                                            |> List.map (fun item ->
                                                JsonValue.Record
                                                    [| "path", JsonValue.String item.path
                                                       "entityTypes", item.entityTypes |> List.map JsonValue.String |> List.toArray |> JsonValue.Array |])
                                            |> List.toArray
                                        let ruleValues =
                                            rules
                                            |> List.map (fun rule ->
                                                let references =
                                                    rule.valueReferences
                                                    |> List.map (fun reference ->
                                                        JsonValue.Record
                                                            [| "argumentPath", JsonValue.String reference.argumentPath
                                                               "access", JsonValue.String reference.access
                                                               "typeName", JsonValue.String reference.typeName |])
                                                    |> List.toArray
                                                let fields = ResizeArray<string * JsonValue>()
                                                fields.Add("name", JsonValue.String rule.name)
                                                fields.Add("category", JsonValue.String rule.category)
                                                fields.Add("supportedScopes", rule.supportedScopes |> List.map JsonValue.String |> List.toArray |> JsonValue.Array)
                                                rule.pushScope |> Option.iter (fun scope -> fields.Add("pushScope", JsonValue.String scope))
                                                fields.Add("valueReferences", JsonValue.Array references)
                                                JsonValue.Record(fields.ToArray()))
                                            |> List.toArray
                                        let hasRules = ruleValues.Length > 0
                                        let hasTypes = definitionTypes.Length > 0
                                        let status = if hasRules && hasTypes then "ready" elif hasRules || hasTypes then "partial" else "unavailable"
                                        JsonValue.Record
                                            [| "ok", JsonValue.Boolean true
                                               "status", JsonValue.String status
                                               "gameProfile", JsonValue.String gameName
                                               "rulesGeneration", JsonValue.Number(decimal semanticCatalogGeneration)
                                               "rulesContentHash", JsonValue.String rulesHash
                                               "rules", JsonValue.Array ruleValues
                                               "definitionTypes", JsonValue.Array definitionTypes
                                               "directoryCatalogVersion", JsonValue.Number 1M
                                               "directoryPaths", JsonValue.Array directoryPaths
                                               "directoryPathsTruncated", JsonValue.Boolean false
                                               "warnings", JsonValue.Array(if not hasConfigs then [| JsonValue.String "No active CWT configuration files are loaded." |] else [||]) |] }
                            try
                                match gameDispatcher.Dispatch visitor with
                                | Some result -> Some result
                                | None -> Some(JsonValue.Record [| "ok", JsonValue.Boolean false; "status", JsonValue.String "unavailable"; "error", JsonValue.String "LSP server not ready" |])
                            with error ->
                                Some(JsonValue.Record [| "ok", JsonValue.Boolean false; "status", JsonValue.String "unavailable"; "error", JsonValue.String error.Message |])

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

                        // - cwtools.ai.queryOverrideModes -
                        // Returns path override/load-order modes from the active CWT rules currently loaded by the server.
                        | { command = "cwtools.ai.queryOverrideModes"
                            arguments = rest } ->
                            let pathArg =
                                rest
                                |> List.tryItem 0
                                |> Option.bind (function JsonValue.String s when s.Trim() <> "" -> Some(s.Trim()) | _ -> None)

                            let limitVal =
                                rest
                                |> List.tryItem 1
                                |> Option.bind (function JsonValue.Number n -> Some(int n) | _ -> None)
                                |> Option.defaultValue 250
                                |> fun value -> max 0 (min 1000 value)

                            let priorityToJson (priority: CWTools.Rules.ConfigPriority) =
                                JsonValue.Record
                                    [| "path", JsonValue.String priority.path
                                       "strategy", JsonValue.String priority.strategy |]

                            let modeInfoToJson (info: CWTools.Rules.ConfigOverrideModeInfo) =
                                JsonValue.Record
                                    [| yield "id", JsonValue.String info.id
                                       match info.name with
                                       | Some name -> yield "name", JsonValue.String name
                                       | None -> ()
                                       match info.description with
                                       | Some desc -> yield "description", JsonValue.String desc
                                       | None -> () |]

                            let result =
                                match gameObj with
                                | Some g ->
                                    let modes = g.OverrideModes()
                                    let modesArr =
                                        modes
                                        |> Array.truncate limitVal
                                        |> Array.map priorityToJson

                                    let modeInfos = g.OverrideModesInfo()

                                    let modeInfoArr =
                                        modeInfos |> Array.map modeInfoToJson

                                    let modeInfoByStrategy =
                                        let table =
                                            System.Collections.Generic.Dictionary<string, CWTools.Rules.ConfigOverrideModeInfo>(
                                                StringComparer.OrdinalIgnoreCase)

                                        for modeInfo in modeInfos do
                                            table.[modeInfo.id] <- modeInfo

                                        table

                                    let fields =
                                        [ yield "ok", JsonValue.Boolean true
                                          yield "source", JsonValue.String "activeRules"
                                          yield "modes", JsonValue.Array modesArr
                                          yield "modeInfo", JsonValue.Array modeInfoArr
                                          yield "totalCount", JsonValue.Number(decimal modes.Length)
                                          match pathArg with
                                          | Some path ->
                                              match g.OverrideModeAtPath path with
                                              | Some matched ->
                                                  yield "matched", priorityToJson matched
                                                  match modeInfoByStrategy.TryGetValue(matched.strategy) with
                                                  | true, info -> yield "matchedModeInfo", modeInfoToJson info
                                                  | false, _ -> ()
                                              | None -> yield "matched", JsonValue.Null
                                          | None -> () ]
                                        |> Array.ofList

                                    JsonValue.Record fields
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
                                            String.Equals(e.filepath, filePath, pathComparison))
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
                                    let currentModelEpoch = modelEpochSnapshot ()
                                    let effectiveFreshness =
                                        if state.validatedVersion <> currentVersion
                                           || not (sameModelEpoch state.modelEpoch currentModelEpoch) then
                                            Stale
                                        else
                                            state.freshness
                                    let freshnessStr =
                                        match effectiveFreshness with
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
                                           "modelEpoch",
                                               JsonValue.Record
                                                   [| "game", JsonValue.Number(decimal state.modelEpoch.game)
                                                      "rules", JsonValue.Number(decimal state.modelEpoch.rules)
                                                      "types", JsonValue.Number(decimal state.modelEpoch.types)
                                                      "localisation", JsonValue.Number(decimal state.modelEpoch.localisation) |]
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

                        // - cwtools.ai.getAllDiagnostics -
                        // Aggregate cached diagnostics across the whole workspace (every analysed
                        // file). Optional args: [severity ("error"|"warning"|"info"|"hint"|"all"); limit].
                        | { command = "cwtools.ai.getAllDiagnostics"
                            arguments = allDiagArgs } ->
                            let severityArg =
                                allDiagArgs |> List.tryItem 0
                                |> Option.bind (function JsonValue.String s when s <> "" -> Some(s.ToLowerInvariant()) | _ -> None)
                            let limitVal =
                                allDiagArgs |> List.tryItem 1
                                |> Option.bind (function JsonValue.Number n -> Some(int n) | _ -> None)
                                |> Option.defaultValue 1000
                            let sevName (s: DiagnosticSeverity option) =
                                match s with
                                | Some DiagnosticSeverity.Error -> "error"
                                | Some DiagnosticSeverity.Warning -> "warning"
                                | Some DiagnosticSeverity.Information -> "info"
                                | Some DiagnosticSeverity.Hint -> "hint"
                                | _ -> "info"
                            // Severity is a minimum threshold: "warning" => errors + warnings, etc.
                            let severityOk sev =
                                match severityArg with
                                | None | Some "all" | Some "hint" -> true
                                | Some "error" -> sev = "error"
                                | Some "warning" -> sev = "error" || sev = "warning"
                                | Some "info" -> sev = "error" || sev = "warning" || sev = "info"
                                | Some other -> sev = other
                            let mutable totalErrors = 0
                            let mutable totalWarnings = 0
                            let mutable matched = 0
                            let collected = System.Collections.Generic.List<JsonValue>()
                            for kvp in fileDiagnosticStates do
                                let filePath = kvp.Key.Replace('\\', '/')
                                for d in kvp.Value.diagnostics do
                                    let sev = sevName d.severity
                                    if sev = "error" then totalErrors <- totalErrors + 1
                                    elif sev = "warning" then totalWarnings <- totalWarnings + 1
                                    if severityOk sev then
                                        matched <- matched + 1
                                        if collected.Count < limitVal then
                                            collected.Add(
                                                JsonValue.Record
                                                    [| "file",     JsonValue.String filePath
                                                       "code",     JsonValue.String (d.code |> Option.defaultValue "")
                                                       "message",  JsonValue.String d.message
                                                       "severity", JsonValue.String sev
                                                       "line",     JsonValue.Number(decimal d.range.start.line)
                                                       "column",   JsonValue.Number(decimal d.range.start.character) |])
                            let result =
                                JsonValue.Record
                                    [| "ok",            JsonValue.Boolean true
                                       "totalFiles",    JsonValue.Number(decimal fileDiagnosticStates.Count)
                                       "totalCount",    JsonValue.Number(decimal matched)
                                       "returnedCount", JsonValue.Number(decimal collected.Count)
                                       "truncated",     JsonValue.Boolean(matched > collected.Count)
                                       "errorCount",    JsonValue.Number(decimal totalErrors)
                                       "warningCount",  JsonValue.Number(decimal totalWarnings)
                                       "diagnostics",   JsonValue.Array(collected.ToArray()) |]
                            Some result

                        // waitDiagnosticsFresh is kept as a non-blocking compatibility alias.
                        // Actual waiting stays client-side to avoid holding an LSP read lock.

                        // - cwtools.ai.getValidationStatus -
                        // Return global verification status summary: current epoch, number of pending files, total number of files
                        | { command = "cwtools.ai.getValidationStatus" } ->
                            Some(validationStatusResult ())

                        | { command = "cwtools.ai.revalidateFiles"
                            arguments = revalArgs } ->
                            let uris =
                                match revalArgs with
                                | (JsonValue.Array arr) :: _ ->
                                    arr |> Array.choose (function JsonValue.String s -> Some s | _ -> None) |> Array.toList
                                | _ ->
                                    revalArgs |> List.choose (function JsonValue.String s -> Some s | _ -> None)
                            let capped = uris |> List.truncate 200
                            let files =
                                capped
                                |> List.map (fun raw ->
                                    let uri = Uri(raw)
                                    let filePath = getPathFromDoc uri
                                    advanceLintGeneration filePath |> ignore
                                    let priorEpoch =
                                        match fileDiagnosticStates.TryGetValue(filePath) with
                                        | true, st -> decimal st.epoch
                                        | _ -> 0m
                                    lintAgent.Post(UpdateRequest({ uri = uri; version = 0 }, diskRefreshRequest))
                                    JsonValue.Record
                                        [| "file",       JsonValue.String(filePath.Replace('\\', '/'))
                                           "priorEpoch", JsonValue.Number priorEpoch |])
                                |> Array.ofList
                            Some(
                                JsonValue.Record
                                    [| "ok",            JsonValue.Boolean true
                                       "baselineEpoch", JsonValue.Number(decimal diagnosticEpoch.Value)
                                       "requested",     JsonValue.Number(decimal capped.Length)
                                       "truncated",     JsonValue.Boolean(uris.Length > capped.Length)
                                       "files",         JsonValue.Array files |])

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

                    | None ->
                        match p with
                        | { command = "cwtools.ai.queryProjectKnowledgeDb"
                            arguments = args } -> Some(queryProjectKnowledgeDbCommand args)
                        | _ -> None
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
