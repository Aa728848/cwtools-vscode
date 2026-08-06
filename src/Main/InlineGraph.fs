module Main.InlineGraph

open System
open System.Collections.Generic
open System.Text.RegularExpressions
open FSharp.Data
open CWTools.Games
open CWTools.Process

/// Inline-script instantiation graph.
///
/// Turns `inline_script = path` / `inline_script = { script = path ARG = value }`
/// into first-class facts: templates, parameters, invocations, arguments and
/// expansions, with a bidirectional source map and structured parameter
/// problems. All extraction is bounded and deterministic.

type InlineTemplateFact =
    { templateId: string
      logicalPath: string
      file: string
      line: int
      contentHash: string }

type InlineParameterFact =
    { templateId: string
      name: string
      usageKind: string
      usageKinds: string list
      inferredType: string
      required: bool
      occurrences: int }

type InlineInvocationFact =
    { invocationId: string
      callerFile: string
      callerLine: int
      templateId: string
      enclosingDefinition: string option }

type InlineArgumentFact =
    { invocationId: string
      name: string
      rawValue: string
      resolvedValue: string
      valueKind: string }

type InlineExpansionFact =
    { invocationId: string
      expandedSymbolId: string
      entityType: string
      templateFile: string
      callerFile: string
      templateLine: int
      generatedLine: int
      confidence: string }

type InlineGeneratedReferenceFact =
    { invocationId: string
      referenceKind: string
      expandedValue: string
      templateFile: string
      callerFile: string
      templateLine: int
      generatedLine: int
      confidence: string }

type InlineProblemFact =
    { invocationId: string
      kind: string
      message: string
      line: int }

type InlineGraphFacts =
    { templates: InlineTemplateFact list
      parameters: InlineParameterFact list
      invocations: InlineInvocationFact list
      arguments: InlineArgumentFact list
      expansions: InlineExpansionFact list
      generatedReferences: InlineGeneratedReferenceFact list
      problems: InlineProblemFact list }

type InlineGraphQuery =
    { template: string option
      callerFile: string option
      callerLine: int option
      limit: int }

let private parameterPattern = Regex(@"\$([A-Za-z_][A-Za-z0-9_]*)\$", RegexOptions.Compiled)
let private inlineScriptKey = "inline_script"
let private scriptKey = "script"

let private usageKindForField (fieldName: string) isKey =
    let lower = fieldName.ToLowerInvariant()
    if isKey || lower = "id" || lower = "key" || lower = "name" then "identifier"
    elif lower.Contains "scope" || lower.Contains "target" || lower.StartsWith "event_target" then "scope_or_target"
    elif lower.Contains "title" || lower.Contains "desc" || lower.Contains "text" || lower.Contains "tooltip" || lower.Contains "localisation" then "localisation_key"
    elif lower.Contains "sprite" || lower.Contains "icon" || lower.Contains "picture" || lower.Contains "texture" || lower.Contains "gfx" then "gfx_reference"
    elif lower.Contains "path" || lower.Contains "file" then "path"
    elif lower.Contains "type" then "entity_type"
    elif lower.Contains "factor" || lower.Contains "weight" || lower.Contains "amount" || lower.Contains "value" || lower.Contains "days" || lower.Contains "months" || lower.Contains "years" then "scalar"
    else "generic_fragment"

let private inferredTypeFor usages =
    match usages with
    | [ "identifier" ] -> "identifier"
    | [ "localisation_key" ] -> "localisation_key"
    | [ "gfx_reference" ] -> "gfx_reference"
    | [ "path" ] -> "path"
    | [ "scope_or_target" ] -> "scope"
    | [ "entity_type" ] -> "entity_type"
    | [ "scalar" ] -> "scalar"
    | [ "generic_fragment" ] -> "fragment"
    | [] -> "unknown"
    | _ -> "incompatible"

let private normalizePath (value: string) =
    value.Replace('\\', '/').Trim().TrimStart('/').ToLowerInvariant()

let private templateIdFor (logicalPath: string) =
    let normalized = normalizePath logicalPath
    let withoutExtension =
        if normalized.EndsWith(".txt", StringComparison.OrdinalIgnoreCase) then
            normalized.Substring(0, normalized.Length - 4)
        else normalized
    let prefix = "common/inline_scripts/"
    if withoutExtension.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) then
        withoutExtension.Substring(prefix.Length)
    else withoutExtension

let private hashContent (content: string) =
    let bytes = Text.Encoding.UTF8.GetBytes(content)
    use sha = Security.Cryptography.SHA256.Create()
    Convert.ToHexString(sha.ComputeHash(bytes)).ToLowerInvariant()

let private isInlineTemplateFile (filePath: string) =
    let normalized = normalizePath filePath
    normalized.Contains "/inline_scripts/"

/// Collect `$PARAM$` occurrences together with the syntactic field context in
/// which each placeholder is used.  The field context is substantially more
/// reliable than guessing from the parameter's own name.
let private collectParameterUsages (node: Node) =
    let values = Dictionary<string, int * HashSet<string>>(StringComparer.OrdinalIgnoreCase)
    let collectRaw (raw: string) usage =
        for m in parameterPattern.Matches raw do
            let name = m.Groups.[1].Value
            let count, usages =
                match values.TryGetValue name with
                | true, current -> current
                | _ -> 0, HashSet<string>(StringComparer.OrdinalIgnoreCase)
            usages.Add usage |> ignore
            values.[name] <- count + 1, usages
    let rec visit (n: Node) =
        collectRaw n.Key (usageKindForField n.Key true)
        for leaf in n.Values do
            collectRaw leaf.Key (usageKindForField leaf.Key true)
            collectRaw (string leaf.Value) (usageKindForField leaf.Key false)
        for child in n.Nodes do visit child
    visit node
    values
    |> Seq.map (fun pair ->
        let occurrences, usageSet = pair.Value
        let usages = usageSet |> Seq.sort |> Seq.toList
        pair.Key, occurrences, usages)
    |> Seq.sortBy (fun (name, _, _) -> name.ToLowerInvariant())
    |> Seq.toList

let private collectParameters node =
    collectParameterUsages node |> List.map (fun (name, occurrences, _) -> name, occurrences)

let private renderExpandedId (template: string) (args: Map<string, string>) =
    let mutable result = template
    for KeyValue(name, value) in args do
        result <- result.Replace("$" + name + "$", value)
    result

/// Extract the top-level definition identity of an inline template body.
/// Returns (idTemplate, entityTypeHint) when the body declares a named block.
let private topLevelIdentities (node: Node) =
    node.Nodes
    |> Seq.choose (fun child ->
        let identityLeaf =
            child.Leaves
            |> Seq.tryFind (fun leaf ->
                leaf.Key.Equals("id", StringComparison.OrdinalIgnoreCase)
                || leaf.Key.Equals("key", StringComparison.OrdinalIgnoreCase)
                || leaf.Key.Equals("name", StringComparison.OrdinalIgnoreCase))
        let identityTemplate =
            identityLeaf
            |> Option.map (fun leaf -> string leaf.Value)
            |> Option.filter (fun value -> value.Contains "$" || not (child.Key.Contains "$"))
            |> Option.orElseWith (fun () -> if child.Key.Contains "$" then Some child.Key else None)
        identityTemplate
        |> Option.map (fun template ->
            template, child.Key, int child.Position.StartLine))
    |> Seq.toList

let private referenceKindForField (fieldName: string) =
    let lower = fieldName.ToLowerInvariant()
    if lower.Contains "title" || lower.Contains "desc" || lower.Contains "text" || lower.Contains "tooltip" || lower.Contains "localisation" then Some "localisation"
    elif lower.Contains "sprite" || lower.Contains "icon" || lower.Contains "picture" || lower.Contains "texture" || lower.Contains "gfx" then Some "gfx"
    elif lower.Contains "path" || lower.Contains "file" then Some "path"
    elif lower.EndsWith("_event", StringComparison.Ordinal) || lower = "event" || lower = "fire_on_action" then Some "event"
    elif lower.Contains "special_project" then Some "special_project"
    elif lower.Contains "modifier" then Some "modifier"
    else None

let private renderedReferences (template: Node) args =
    let references = ResizeArray<string * string * int>()
    let stateOperation (key: string) =
        let lower = key.ToLowerInvariant()
        if lower.StartsWith("save_") && lower.Contains("event_target") then Some "save"
        elif lower.StartsWith("set_") && (lower.Contains("variable") || lower.EndsWith("_flag")) then Some "set"
        elif lower.StartsWith("change_") && lower.Contains("variable") then Some "write"
        elif (lower.StartsWith("remove_") || lower.StartsWith("clear_")) && (lower.Contains("variable") || lower.Contains("flag") || lower.Contains("event_target")) then Some "clear"
        elif (lower.StartsWith("has_") || lower.StartsWith("check_") || lower.StartsWith("is_")) && (lower.Contains("variable") || lower.Contains("flag") || lower.Contains("event_target")) then Some "read"
        else None
    let stateScope (key: string) =
        let lower = key.ToLowerInvariant()
        if lower.Contains("global_event_target") then "global"
        elif lower.Contains("event_target") then "local_event"
        elif lower.Contains("country") then "country"
        elif lower.Contains("planet") then "planet"
        elif lower.Contains("fleet") then "fleet"
        elif lower.Contains("ship") then "ship"
        elif lower.Contains("system") then "system"
        else "current_scope"
    let subjectFromNode (node: Node) =
        node.Values
        |> Seq.tryFind (fun value ->
            let key = value.Key.ToLowerInvariant()
            key = "which" || key = "name" || key = "flag" || key = "id" || key = "target")
        |> Option.orElseWith (fun () -> node.Values |> Seq.tryHead)
        |> Option.map (fun value -> renderExpandedId (string value.Value) args |> fun raw -> raw.Trim().Trim('"'))
    let rec visit (node: Node) =
        let nodeKey = renderExpandedId node.Key args
        match stateOperation nodeKey, subjectFromNode node with
        | Some operation, Some subject when not (String.IsNullOrWhiteSpace subject) && not (subject.Contains "$" ) ->
            references.Add($"state:{operation}:{stateScope nodeKey}", subject, int node.Position.StartLine)
        | _ -> ()
        if nodeKey.EndsWith("_event", StringComparison.OrdinalIgnoreCase) || nodeKey.Equals("fire_on_action", StringComparison.OrdinalIgnoreCase) then
            let targetKeys = if nodeKey.Equals("fire_on_action", StringComparison.OrdinalIgnoreCase) then [ "on_action"; "name"; "id" ] else [ "id" ]
            node.Values
            |> Seq.tryFind (fun value -> targetKeys |> List.exists (fun key -> value.Key.Equals(key, StringComparison.OrdinalIgnoreCase)))
            |> Option.map (fun value -> renderExpandedId (string value.Value) args |> fun raw -> raw.Trim().Trim('"'))
            |> Option.filter (fun value -> not (String.IsNullOrWhiteSpace value) && not (value.Contains "$"))
            |> Option.iter (fun value -> references.Add("event", value, int node.Position.StartLine))
        if not (nodeKey.Equals("root", StringComparison.OrdinalIgnoreCase)) && not (nodeKey.Contains "$" ) then
            references.Add("call_candidate", nodeKey, int node.Position.StartLine)
        for leaf in node.Values do
            match stateOperation leaf.Key with
            | Some operation ->
                let rendered = renderExpandedId (string leaf.Value) args |> fun raw -> raw.Trim().Trim('"')
                if not (String.IsNullOrWhiteSpace rendered) && not (rendered.Contains "$" ) then
                    references.Add($"state:{operation}:{stateScope leaf.Key}", rendered, int leaf.Position.StartLine)
            | None -> ()
            match referenceKindForField leaf.Key with
            | Some kind ->
                let rendered = renderExpandedId (string leaf.Value) args
                if not (String.IsNullOrWhiteSpace rendered) && not (rendered.Contains "$" ) then
                    references.Add(kind, rendered.Trim().Trim('"'), int leaf.Position.StartLine)
            | None -> ()
        for child in node.Nodes do visit child
    visit template
    references |> Seq.distinct |> Seq.toList

/// Extract inline invocations from an entity AST. Handles both the leaf form
/// (`inline_script = path`) and the block form (`inline_script = { script = path ARG = value }`).
let private collectInvocations (root: Node) (filePath: string) =
    let invocations = ResizeArray<InlineInvocationFact>()
    let arguments = ResizeArray<InlineArgumentFact>()
    let problems = ResizeArray<InlineProblemFact>()
    let mutable counter = 0
    let addInvocation (templatePath: string option) (line: int) (argNodes: Node list) (argLeaves: (string * string) list) (enclosingDefinition: string option) =
        counter <- counter + 1
        let invocationId = sprintf "%s#%d" (normalizePath filePath) counter
        match templatePath with
        | Some rawPath when not (String.IsNullOrWhiteSpace rawPath) ->
            let trimmed = rawPath.Trim().Trim('"')
            let templateId = templateIdFor trimmed
            invocations.Add
                { invocationId = invocationId
                  callerFile = filePath
                  callerLine = line
                  templateId = templateId
                  enclosingDefinition = enclosingDefinition }
            for argNode in argNodes do
                let rawValue =
                    match argNode.Values with
                    | leaf :: _ -> string leaf.Value
                    | _ -> ""
                arguments.Add
                    { invocationId = invocationId
                      name = argNode.Key
                      rawValue = rawValue.Trim().Trim('"')
                      resolvedValue = rawValue.Trim().Trim('"')
                      valueKind = if Seq.isEmpty argNode.Nodes then "scalar" else "block" }
            for argName, argValue in argLeaves do
                arguments.Add
                    { invocationId = invocationId
                      name = argName
                      rawValue = argValue.Trim().Trim('"')
                      resolvedValue = argValue.Trim().Trim('"')
                      valueKind = "scalar" }
        | _ ->
            invocations.Add
                { invocationId = invocationId
                  callerFile = normalizePath filePath
                  callerLine = line
                  templateId = ""
                  enclosingDefinition = enclosingDefinition }
            problems.Add
                { invocationId = invocationId
                  kind = "missing_script"
                  message = "Inline script invocation has no resolvable script path."
                  line = line }
    let rec visit (node: Node) (enclosingDefinition: string option) =
        // Scalar assignments are represented by Node.Values rather than by
        // Node.All. Walking only the latter silently loses the common
        // `inline_script = path` form.
        for value in node.Values do
            if value.Key = inlineScriptKey then
                addInvocation (Some(string value.Value)) (int value.Position.StartLine) [] [] enclosingDefinition
        for child in node.All do
            match child with
            | NodeC childNode ->
                if childNode.Key = inlineScriptKey then
                    let templatePath =
                        let fromNodeScript =
                            childNode.Nodes
                            |> Seq.tryFind (fun inner -> inner.Key = scriptKey)
                            |> Option.bind (fun inner ->
                                inner.Values
                                |> Seq.tryHead
                                |> Option.map (fun leaf -> string leaf.Value))
                        let fromLeafScript =
                            childNode.Values
                            |> Seq.tryFind (fun leaf -> leaf.Key = scriptKey)
                            |> Option.map (fun leaf -> string leaf.Value)
                        fromNodeScript
                        |> Option.orElse fromLeafScript
                    let argNodes =
                        childNode.Nodes
                        |> Seq.filter (fun inner -> inner.Key <> scriptKey)
                        |> Seq.toList
                    let argLeaves =
                        childNode.Values
                        |> Seq.filter (fun leaf -> leaf.Key <> scriptKey)
                        |> Seq.map (fun leaf -> leaf.Key, string leaf.Value)
                        |> Seq.toList
                    addInvocation templatePath (int childNode.Position.StartLine) argNodes argLeaves enclosingDefinition
                let nextEnclosing =
                    if enclosingDefinition.IsNone && not (childNode.Key.Equals("root", StringComparison.OrdinalIgnoreCase)) then
                        childNode.Values
                        |> Seq.tryFind (fun leaf ->
                            leaf.Key.Equals("id", StringComparison.OrdinalIgnoreCase)
                            || leaf.Key.Equals("key", StringComparison.OrdinalIgnoreCase)
                            || leaf.Key.Equals("name", StringComparison.OrdinalIgnoreCase))
                        |> Option.map (fun leaf -> string leaf.Value |> fun value -> value.Trim().Trim('"'))
                        |> Option.orElse (Some childNode.Key)
                    else enclosingDefinition
                visit childNode nextEnclosing
            | LeafC _ -> ()
            | _ -> ()
    visit root None
    invocations |> Seq.toList, arguments |> Seq.toList, problems |> Seq.toList

/// Build the inline graph for a set of entities. Template extraction reads the
/// inline_scripts directory from the same entity set, so caller and callee stay
/// in one coherent snapshot.
let collectInlineGraphCancellable (shouldCancel: unit -> bool) (entities: seq<struct (Entity * 'T)>) : InlineGraphFacts =
    let checkCancelled () = if shouldCancel () then raise (OperationCanceledException("Inline graph collection was cancelled."))
    checkCancelled ()
    let entitiesList = entities |> Seq.toList
    let templates = ResizeArray<InlineTemplateFact>()
    let parameters = ResizeArray<InlineParameterFact>()
    let templateMap = Dictionary<string, Node * string * int>(StringComparer.OrdinalIgnoreCase)
    for struct (entity, _) in entitiesList do
        checkCancelled ()
        if isInlineTemplateFile entity.filepath then
            let templateId = templateIdFor entity.logicalpath
            if not (templateMap.ContainsKey templateId) then
                let content = entity.rawEntity.ToString()
                let lineCount = int (content.Split('\n').Length)
                templateMap.[templateId] <- (entity.rawEntity, content, lineCount)
                templates.Add
                    { templateId = templateId
                      logicalPath = normalizePath entity.logicalpath
                      file = normalizePath entity.filepath
                      line = 1
                      contentHash = hashContent content }

    let invocations = ResizeArray<InlineInvocationFact>()
    let arguments = ResizeArray<InlineArgumentFact>()
    let problems = ResizeArray<InlineProblemFact>()
    for struct (entity, _) in entitiesList do
        checkCancelled ()
        let collectedInvocations, collectedArguments, collectedProblems = collectInvocations entity.rawEntity entity.filepath
        invocations.AddRange collectedInvocations
        arguments.AddRange collectedArguments
        problems.AddRange collectedProblems

    for KeyValue(templateId, (template, _, _)) in templateMap do
        checkCancelled ()
        for name, occurrences, usageKinds in collectParameterUsages template do
            let inferredType = inferredTypeFor usageKinds
            parameters.Add
                { templateId = templateId
                  name = name
                  usageKind = usageKinds |> List.tryHead |> Option.defaultValue "unknown"
                  usageKinds = usageKinds
                  inferredType = inferredType
                  required = true
                  occurrences = occurrences }

    let templateIdByFile =
        templates
        |> Seq.map (fun item -> normalizePath item.file, item.templateId)
        |> dict

    // Expansions: instantiate the full transitive template closure. Internal
    // calls inherit rendered arguments from their parent; all generated facts
    // retain both template and root-call locations for bidirectional mapping.
    let expansions = ResizeArray<InlineExpansionFact>()
    let generatedReferences = ResizeArray<InlineGeneratedReferenceFact>()
    let invocationById = Dictionary<string, InlineInvocationFact>(StringComparer.OrdinalIgnoreCase)
    for invocation in invocations do invocationById.[invocation.invocationId] <- invocation
    let argumentsByInvocation =
        arguments
        |> Seq.groupBy (fun arg -> arg.invocationId)
        |> Seq.map (fun (id, values) -> id, values |> Seq.map (fun arg -> arg.name, arg.resolvedValue) |> Map.ofSeq)
        |> dict
    let invocationsByCallerTemplate =
        invocations
        |> Seq.choose (fun invocation ->
            match templateIdByFile.TryGetValue(normalizePath invocation.callerFile) with
            | true, callerTemplate -> Some(callerTemplate, invocation)
            | _ -> None)
        |> Seq.groupBy fst
        |> Seq.map (fun (templateId, values) -> templateId, values |> Seq.map snd |> Seq.toList)
        |> dict

    let externalInvocations =
        invocations
        |> Seq.filter (fun invocation -> not (templateIdByFile.ContainsKey(normalizePath invocation.callerFile)))
        |> Seq.toList

    for invocation in externalInvocations do
        checkCancelled ()
        let mutable resolved = false
        if String.IsNullOrWhiteSpace invocation.templateId then
            resolved <- true // malformed call already has a precise missing_script problem
        let templateLookup =
            if String.IsNullOrWhiteSpace invocation.templateId then None
            else match templateMap.TryGetValue invocation.templateId with
                 | true, value -> Some value
                 | false, _ -> None
        match templateLookup with
        | Some (template, _, _) ->
            let args =
                match argumentsByInvocation.TryGetValue invocation.invocationId with
                | true, values -> values
                | _ -> Map.empty
            let used = HashSet<string>(StringComparer.OrdinalIgnoreCase)
            for KeyValue(name, _) in args do used.Add name |> ignore
            let rec instantiate currentTemplateId currentArgs depth (stack: Set<string>) =
                checkCancelled ()
                if depth <= 32 && not (stack.Contains currentTemplateId) then
                    match templateMap.TryGetValue currentTemplateId with
                    | true, (currentTemplate, _, _) ->
                        let templateFile =
                            templates
                            |> Seq.tryFind (fun item -> item.templateId.Equals(currentTemplateId, StringComparison.OrdinalIgnoreCase))
                            |> Option.map _.file
                            |> Option.defaultValue currentTemplateId
                        for idTemplate, entityTypeTemplate, templateLine in topLevelIdentities currentTemplate do
                            let expandedId = renderExpandedId idTemplate currentArgs
                            let renderedType = renderExpandedId entityTypeTemplate currentArgs |> fun value -> value.ToLowerInvariant()
                            let entityTypeHint =
                                if renderedType.EndsWith("_event") || renderedType = "event" then "event"
                                elif renderedType.Contains "modifier" then "modifier"
                                elif renderedType.Contains "project" then "special_project"
                                else renderedType
                            if not (String.IsNullOrWhiteSpace expandedId) && not (expandedId.Contains "$") then
                                if Regex.IsMatch(expandedId, @"^[A-Za-z0-9_@.:-]+$") then
                                    expansions.Add
                                        { invocationId = invocation.invocationId
                                          expandedSymbolId = expandedId
                                          entityType = entityTypeHint
                                          templateFile = templateFile
                                          callerFile = normalizePath invocation.callerFile
                                          templateLine = templateLine
                                          generatedLine = invocation.callerLine
                                          confidence = if depth = 0 then "expanded" else "transitive_expanded" }
                                    resolved <- true
                                else
                                    problems.Add
                                        { invocationId = invocation.invocationId
                                          kind = "invalid_identifier"
                                          message = sprintf "Expanded identifier '%s' contains characters that are not legal in a PDXScript identifier." expandedId
                                          line = invocation.callerLine }
                        for kind, value, templateLine in renderedReferences currentTemplate currentArgs do
                            generatedReferences.Add
                                { invocationId = invocation.invocationId
                                  referenceKind = kind
                                  expandedValue = value
                                  templateFile = templateFile
                                  callerFile = normalizePath invocation.callerFile
                                  templateLine = templateLine
                                  generatedLine = invocation.callerLine
                                  confidence = if depth = 0 then "expanded" else "transitive_expanded" }
                        match invocationsByCallerTemplate.TryGetValue currentTemplateId with
                        | true, childInvocations ->
                            for child in childInvocations do
                                let childTemplateId = renderExpandedId child.templateId currentArgs |> templateIdFor
                                let childArgs =
                                    match argumentsByInvocation.TryGetValue child.invocationId with
                                    | true, values -> values |> Map.map (fun _ value -> renderExpandedId value currentArgs)
                                    | _ -> Map.empty
                                instantiate childTemplateId childArgs (depth + 1) (stack.Add currentTemplateId)
                        | _ -> ()
                    | _ -> ()
            instantiate invocation.templateId args 0 Set.empty
            // Parameter usage problems: unused parameters and missing required ones.
            let templateParameterUsages = collectParameterUsages template
            let templateParameterNames = templateParameterUsages |> Seq.map (fun (name, _, _) -> name) |> HashSet<string>
            for parameter in templateParameterNames do
                if not (used.Contains parameter) then
                    problems.Add
                        { invocationId = invocation.invocationId
                          kind = "missing_parameter"
                          message = sprintf "Template '%s' requires parameter $%s$ which this invocation does not provide." invocation.templateId parameter
                          line = invocation.callerLine }
            for KeyValue(name, _) in args do
                if not (templateParameterNames.Contains name) then
                    problems.Add
                        { invocationId = invocation.invocationId
                          kind = "unused_parameter"
                          message = sprintf "Invocation provides parameter '%s' that template '%s' never uses." name invocation.templateId
                          line = invocation.callerLine }
            for name, _, usages in templateParameterUsages do
                if inferredTypeFor usages = "incompatible" then
                    problems.Add
                        { invocationId = invocation.invocationId
                          kind = "incompatible_parameter_usage"
                          message = sprintf "Parameter $%s$ is used in incompatible contexts: %s." name (String.concat ", " usages)
                          line = invocation.callerLine }
        | None when not (String.IsNullOrWhiteSpace invocation.templateId) ->
            problems.Add
                { invocationId = invocation.invocationId
                  kind = "unresolved_template"
                  message = sprintf "Inline script template '%s' was not found in the inline_scripts directory." invocation.templateId
                  line = invocation.callerLine }
        | None -> ()
        if not resolved then
            problems.Add
                { invocationId = invocation.invocationId
                  kind = "no_expansion"
                  message = "Invocation produces no top-level definition; verify the template declares a named block."
                  line = invocation.callerLine }

    // Template recursion/cycles. A template file is itself a caller, so its
    // outgoing inline invocations form a bounded template-to-template graph.
    let templateEdges = Dictionary<string, ResizeArray<string>>(StringComparer.OrdinalIgnoreCase)
    for invocation in invocations do
        checkCancelled ()
        match templateIdByFile.TryGetValue(normalizePath invocation.callerFile) with
        | true, callerTemplate when not (String.IsNullOrWhiteSpace invocation.templateId) ->
            let targets =
                match templateEdges.TryGetValue callerTemplate with
                | true, values -> values
                | _ -> let values = ResizeArray<string>() in templateEdges.[callerTemplate] <- values; values
            targets.Add invocation.templateId
        | _ -> ()
    let reaches start target =
        let visited = HashSet<string>(StringComparer.OrdinalIgnoreCase)
        let rec walk current depth =
            if depth > 100 || not (visited.Add current) then false
            elif current.Equals(target, StringComparison.OrdinalIgnoreCase) then true
            else
                match templateEdges.TryGetValue current with
                | true, values -> values |> Seq.exists (fun next -> walk next (depth + 1))
                | _ -> false
        walk start 0
    for invocation in invocations do
        match templateIdByFile.TryGetValue(normalizePath invocation.callerFile) with
        | true, callerTemplate when reaches invocation.templateId callerTemplate ->
            problems.Add
                { invocationId = invocation.invocationId
                  kind = "recursive_template"
                  message = sprintf "Inline template call '%s' participates in a recursion cycle." invocation.templateId
                  line = invocation.callerLine }
        | _ -> ()

    // Colliding expanded definitions are actionable at every contributing
    // call site, rather than silently collapsing to one symbol.
    for _, collisions in expansions |> Seq.groupBy (fun item -> item.entityType.ToLowerInvariant(), item.expandedSymbolId.ToLowerInvariant()) do
        let items = collisions |> Seq.toList
        if items.Length > 1 then
            for item in items do
                match invocationById.TryGetValue item.invocationId with
                | true, invocation ->
                    problems.Add
                        { invocationId = item.invocationId
                          kind = "duplicate_expansion"
                          message = sprintf "Multiple inline invocations expand to %s '%s'." item.entityType item.expandedSymbolId
                          line = invocation.callerLine }
                | _ -> ()

    checkCancelled ()
    { templates = templates |> Seq.toList
      parameters = parameters |> Seq.toList
      invocations = invocations |> Seq.toList
      arguments = arguments |> Seq.toList
      expansions = expansions |> Seq.toList
      generatedReferences = generatedReferences |> Seq.toList
      problems = problems |> Seq.toList }

let collectInlineGraph (entities: seq<struct (Entity * 'T)>) : InlineGraphFacts =
    collectInlineGraphCancellable (fun () -> false) entities

let filterInlineGraph (query: InlineGraphQuery) (facts: InlineGraphFacts) =
    let limit = max 1 (min query.limit 200)
    let requestedTemplate = query.template |> Option.map templateIdFor
    let requestedFile = query.callerFile |> Option.map normalizePath
    let templateByFile =
        facts.templates |> Seq.map (fun item -> normalizePath item.file, item.templateId) |> dict
    let relevantTemplates = HashSet<string>(StringComparer.OrdinalIgnoreCase)
    requestedTemplate |> Option.iter (relevantTemplates.Add >> ignore)
    let mutable changed = requestedTemplate.IsSome
    let mutable closureDepth = 0
    while changed && closureDepth < 100 do
        changed <- false
        closureDepth <- closureDepth + 1
        for invocation in facts.invocations do
            if relevantTemplates.Contains invocation.templateId then
                match templateByFile.TryGetValue(normalizePath invocation.callerFile) with
                | true, callerTemplate when relevantTemplates.Add callerTemplate -> changed <- true
                | _ -> ()
    let matchesInvocation (invocation: InlineInvocationFact) =
        let templateMatches =
            requestedTemplate
            |> Option.forall (fun _ ->
                relevantTemplates.Contains invocation.templateId
                || match templateByFile.TryGetValue(normalizePath invocation.callerFile) with
                   | true, callerTemplate -> relevantTemplates.Contains callerTemplate
                   | _ -> false)
        let fileMatches =
            requestedFile
            |> Option.forall (fun file ->
                let caller = normalizePath invocation.callerFile
                caller = file || caller.EndsWith("/" + file, StringComparison.OrdinalIgnoreCase))
        let lineMatches = query.callerLine |> Option.forall ((=) invocation.callerLine)
        templateMatches && fileMatches && lineMatches
    let matchingInvocations = facts.invocations |> List.filter matchesInvocation
    let selectedInvocations = matchingInvocations |> List.truncate limit
    let invocationIds = selectedInvocations |> Seq.map (fun item -> item.invocationId) |> HashSet<string>
    let templateIds =
        seq {
            yield! selectedInvocations |> Seq.map (fun item -> item.templateId)
            yield! requestedTemplate |> Option.toList
        }
        |> HashSet<string>
    let filtered =
        { templates = facts.templates |> List.filter (fun item -> templateIds.Contains item.templateId)
          parameters = facts.parameters |> List.filter (fun item -> templateIds.Contains item.templateId)
          invocations = selectedInvocations
          arguments = facts.arguments |> List.filter (fun item -> invocationIds.Contains item.invocationId)
          expansions = facts.expansions |> List.filter (fun item -> invocationIds.Contains item.invocationId)
          generatedReferences = facts.generatedReferences |> List.filter (fun item -> invocationIds.Contains item.invocationId)
          problems = facts.problems |> List.filter (fun item -> invocationIds.Contains item.invocationId) }
    filtered, matchingInvocations.Length > selectedInvocations.Length, matchingInvocations.Length

let private jsonRecord fields = fields |> List.choose id |> List.toArray |> JsonValue.Record
let private jsonStringArray values = values |> Seq.map JsonValue.String |> Seq.toArray |> JsonValue.Array

let inlineGraphJsonWithCoverageAndFreshness (facts: InlineGraphFacts) (truncated: bool) (consideredInvocations: int) freshness staleReasons =
    jsonRecord
        [ Some("ok", JsonValue.Boolean true)
          Some("source", JsonValue.String "cwtools-inline-instantiation")
          Some("version", JsonValue.Number 3m)
          Some("freshness", jsonRecord
              [ Some("status", JsonValue.String freshness)
                Some("source", JsonValue.String "active_lsp_model")
                Some("staleReasons", jsonStringArray staleReasons) ])
          Some("templates", facts.templates
              |> List.sortBy (fun item -> item.templateId)
              |> List.map (fun item ->
                  jsonRecord
                      [ Some("templateId", JsonValue.String item.templateId)
                        Some("logicalPath", JsonValue.String item.logicalPath)
                        Some("file", JsonValue.String item.file)
                        Some("line", JsonValue.Number(decimal item.line))
                        Some("contentHash", JsonValue.String item.contentHash) ])
              |> List.toArray |> JsonValue.Array)
          Some("parameters", facts.parameters
              |> List.sortBy (fun item -> item.name)
              |> List.map (fun item ->
                  jsonRecord
                      [ Some("templateId", JsonValue.String item.templateId)
                        Some("name", JsonValue.String item.name)
                        Some("usageKind", JsonValue.String item.usageKind)
                        Some("usageKinds", jsonStringArray item.usageKinds)
                        Some("inferredType", JsonValue.String item.inferredType)
                        Some("required", JsonValue.Boolean item.required)
                        Some("occurrences", JsonValue.Number(decimal item.occurrences)) ])
              |> List.toArray |> JsonValue.Array)
          Some("invocations", facts.invocations
              |> List.sortBy (fun item -> item.invocationId)
              |> List.map (fun item ->
                  jsonRecord
                      [ Some("invocationId", JsonValue.String item.invocationId)
                        Some("callerFile", JsonValue.String item.callerFile)
                        Some("callerLine", JsonValue.Number(decimal item.callerLine))
                        Some("templateId", JsonValue.String item.templateId)
                        item.enclosingDefinition |> Option.map (fun value -> "enclosingDefinition", JsonValue.String value) ])
              |> List.toArray |> JsonValue.Array)
          Some("arguments", facts.arguments
              |> List.sortBy (fun item -> item.invocationId, item.name)
              |> List.map (fun item ->
                  jsonRecord
                      [ Some("invocationId", JsonValue.String item.invocationId)
                        Some("name", JsonValue.String item.name)
                        Some("rawValue", JsonValue.String item.rawValue)
                        Some("resolvedValue", JsonValue.String item.resolvedValue)
                        Some("valueKind", JsonValue.String item.valueKind) ])
              |> List.toArray |> JsonValue.Array)
          Some("expansions", facts.expansions
              |> List.sortBy (fun item -> item.expandedSymbolId)
              |> List.map (fun item ->
                  jsonRecord
                      [ Some("invocationId", JsonValue.String item.invocationId)
                        Some("expandedSymbolId", JsonValue.String item.expandedSymbolId)
                        Some("entityType", JsonValue.String item.entityType)
                        Some("templateFile", JsonValue.String item.templateFile)
                        Some("callerFile", JsonValue.String item.callerFile)
                        Some("templateLine", JsonValue.Number(decimal item.templateLine))
                        Some("generatedLine", JsonValue.Number(decimal item.generatedLine))
                        Some("confidence", JsonValue.String item.confidence) ])
              |> List.toArray |> JsonValue.Array)
          Some("generatedReferences", facts.generatedReferences
              |> List.sortBy (fun item -> item.invocationId, item.referenceKind, item.expandedValue)
              |> List.map (fun item ->
                  jsonRecord
                      [ Some("invocationId", JsonValue.String item.invocationId)
                        Some("referenceKind", JsonValue.String item.referenceKind)
                        Some("expandedValue", JsonValue.String item.expandedValue)
                        Some("templateFile", JsonValue.String item.templateFile)
                        Some("callerFile", JsonValue.String item.callerFile)
                        Some("templateLine", JsonValue.Number(decimal item.templateLine))
                        Some("generatedLine", JsonValue.Number(decimal item.generatedLine))
                        Some("confidence", JsonValue.String item.confidence) ])
              |> List.toArray |> JsonValue.Array)
          Some("problems", facts.problems
              |> List.sortBy (fun item -> item.invocationId, item.kind)
              |> List.map (fun item ->
                  jsonRecord
                      [ Some("invocationId", JsonValue.String item.invocationId)
                        Some("kind", JsonValue.String item.kind)
                        Some("message", JsonValue.String item.message)
                        Some("line", JsonValue.Number(decimal item.line)) ])
              |> List.toArray |> JsonValue.Array)
          Some("coverage", jsonRecord
              [ Some("filesConsidered", JsonValue.Number(decimal (facts.templates |> Seq.map _.file |> Seq.append (facts.invocations |> Seq.map _.callerFile) |> Seq.distinct |> Seq.length)))
                Some("filesIndexed", JsonValue.Number(decimal (facts.templates |> Seq.map _.file |> Seq.append (facts.invocations |> Seq.map _.callerFile) |> Seq.distinct |> Seq.length)))
                Some("definitionsConsidered", JsonValue.Number(decimal consideredInvocations))
                Some("definitionsIndexed", JsonValue.Number(decimal facts.invocations.Length))
                Some("templatesIndexed", JsonValue.Number(decimal facts.templates.Length))
                Some("invocationsConsidered", JsonValue.Number(decimal consideredInvocations))
                Some("invocationsIndexed", JsonValue.Number(decimal facts.invocations.Length))
                Some("expansionsResolved", JsonValue.Number(decimal facts.expansions.Length))
                Some("generatedReferencesResolved", JsonValue.Number(decimal facts.generatedReferences.Length))
                Some("problemsFound", JsonValue.Number(decimal facts.problems.Length))
                Some("truncated", JsonValue.Boolean truncated)
                Some("staleReasons", jsonStringArray staleReasons)
                Some("unsupportedConstructs", JsonValue.Array [||]) ]) ]

let inlineGraphJsonWithCoverage facts truncated consideredInvocations =
    inlineGraphJsonWithCoverageAndFreshness facts truncated consideredInvocations "fresh" []

let inlineGraphJson (facts: InlineGraphFacts) =
    inlineGraphJsonWithCoverage facts false facts.invocations.Length
