module Main.Lang.CwtLanguageFeatures

open System
open System.Collections.Generic
open System.IO
open CWTools.CwtLanguage
open CWTools.Common
open CWTools.Games
open CWTools.Utilities.Position
open LSP
open LSP.Types

/// Diagnostic tuple consumed by Program.fs's publish pipeline:
/// (code, severity, fileName, message, range, keyLength, relatedErrors).
type CwtErrorTuple = string * Severity * string * string * range * int * (CWRelatedError list) option

/// Resolves a stable CwtDiagnostic.messageKey into concrete text at the
/// server-side localization boundary (handoff doc §5). Full English/Chinese
/// catalogs land in Phase 5; the texts below are the English defaults.
let private messageText (d: CwtDiagnostic) : string =
    match d.messageKey, d.messageArgs with
    | "cwt.syntaxError", msg :: _ -> $"CWT syntax error: %s{msg}"
    | "cwt.unknownDirective", name :: _ ->
        $"Unknown CWT directive '## %s{name}'. Known directives are listed in the rule guide."
    | "cwt.directiveMissingValue", name :: _ -> $"Directive '## %s{name}' requires a value."
    | "cwt.directiveValueNotAllowed", name :: _ -> $"Directive '## %s{name}' does not take a value."
    | "cwt.illegalDirectiveValue", name :: value :: _ -> $"Illegal value '%s{value}' for directive '## %s{name}'."
    | "cwt.emptyDeclaration", decl :: _ -> $"Empty %s{decl} declaration name."
    | "cwt.invalidTypesDeclaration", _ ->
        "Only 'type[...]' declarations are allowed inside 'types'."
    | "cwt.invalidEnumsDeclaration", _ ->
        "Only 'enum[...]' or 'complex_enum[...]' declarations are allowed inside 'enums'."
    | "cwt.invalidValuesDeclaration", _ ->
        "Only 'value[...]' declarations are allowed inside 'values'."
    | "cwt.unknownFieldExpression", token :: _ -> $"Unknown field expression '%s{token}'."
    | "cwt.illegalFieldExpression", name :: token :: _ ->
        $"Malformed '%s{name}' field expression: '%s{token}'."
    | "cwt.undefinedReference", name :: _ ->
        $"Reference to undefined symbol '%s{name}'. Define it in a rule file, or check the spelling."
    | "cwt.duplicateType", name :: _ ->
        $"Type '%s{name}' is declared more than once in this file; later declarations shadow earlier ones."
    | "cwt.injectCycle", target :: _ ->
        $"## inject forms a cycle through '%s{target}'. Break the loop by removing one inject."
    | _ -> d.code

let private toErrorTuple (d: CwtDiagnostic) : CwtErrorTuple =
    (d.code, d.severity, d.range.FileName, messageText d, d.range, 1, None)

/// Semantic (non-syntax) diagnostics for a .cwt document. Returns [] when the
/// document does not parse; the lint pipeline owns syntax diagnostics.
let semanticDiagnostics (filePath: string) (text: string) : CwtErrorTuple list =
    CwtLanguageService.semanticDiagnostics filePath text |> List.map toErrorTuple

// ------------------------------------------------------------ project index

open System.Threading

/// Latest published project snapshot (None while the index is pending).
/// Guarded by snapshotLock; publication accepts only the newest build.
let private snapshotLock = obj()
let mutable private latestPublishedSnapshot: CwtProjectSnapshot option = None
let mutable private latestRequestedVersion = 0L

type private CwtActivationRejection =
    { version: int64
      filePath: string
      reason: string }

let mutable private latestActivationRejection: CwtActivationRejection option = None

let latestSnapshot () =
    lock snapshotLock (fun () -> latestPublishedSnapshot)

let private sameFullPath (left: string) (right: string) =
    try
        CwtProjectIndex.normalizePath (Path.GetFullPath(left)) = CwtProjectIndex.normalizePath (Path.GetFullPath(right))
    with _ -> false

/// Selects the project root without conflating a game workspace with a rules
/// workspace. CWT-only mode uses the workspace; game mode uses only an explicit
/// manual rules folder.
let selectRuleRoot (isCwtOnly: bool) (useManualRules: bool) (manualRulesFolder: string option) (workspaceRoot: string) =
    if isCwtOnly then
        if String.IsNullOrWhiteSpace workspaceRoot then None else Some workspaceRoot
    elif useManualRules then
        manualRulesFolder |> Option.filter (String.IsNullOrWhiteSpace >> not)
    else
        None

let isManualActivationRoot (isCwtOnly: bool) (useManualRules: bool) (manualRulesFolder: string option) (candidateRoot: string) =
    not isCwtOnly
    && useManualRules
    && (manualRulesFolder |> Option.exists (sameFullPath candidateRoot))

/// Registers a requested rebuild version. Returns the version to build.
let private nextSnapshotVersion () =
    Interlocked.Increment(&latestRequestedVersion)

/// Publishes a build result only when it is the newest requested version
/// (out-of-order rebuild completion must never overwrite a newer snapshot).
let private publishSnapshot (snapshot: CwtProjectSnapshot) =
    lock snapshotLock (fun () ->
        if snapshot.version <> Interlocked.Read(&latestRequestedVersion) then
            false
        else
            latestPublishedSnapshot <- Some snapshot
            true)

/// Directories skipped during rule-file enumeration.
let private ignoredDirectoryNames =
    set [ ".git"; ".hg"; ".svn"; "node_modules"; "bin"; "obj"; "dist"; "out";
          ".vscode"; ".vscode-test"; ".cwtools"; ".cwtools-ai" ]

let private tryResolveFileSystemInfo (info: FileSystemInfo) =
    try
        if not info.Exists then None
        elif info.LinkTarget <> null then
            match info.ResolveLinkTarget(true) with
            | null -> None
            | target -> Some(Path.GetFullPath(target.FullName))
        else
            Some(Path.GetFullPath(info.FullName))
    with _ -> None

/// Enumerates `.cwt` files under a root (bounded, deterministic order),
/// merging open-document overlay text over disk content. Directory and file
/// links are resolved before containment checks; a visited-real-directory set
/// prevents junction/symlink cycles.
let enumerateCwtFiles (root: string) (docs: DocumentStore) (maxFiles: int) : (string * string) list =
    let rootFull =
        try
            tryResolveFileSystemInfo (DirectoryInfo(Path.GetFullPath(root)))
        with _ -> None

    let results = ResizeArray<string>()
    let visitedDirectories = HashSet<string>()
    let visitedFiles = HashSet<string>()

    let rec walk (rootReal: string) (dir: string) =
        if results.Count >= maxFiles then ()
        else
            match tryResolveFileSystemInfo (DirectoryInfo(dir)) with
            | Some realDir when CwtProjectIndex.isPathWithin rootReal realDir ->
                let directoryKey = CwtProjectIndex.normalizePath realDir
                if visitedDirectories.Add(directoryKey) then
                    try
                        Directory.EnumerateFileSystemEntries(realDir)
                        |> Seq.sortBy CwtProjectIndex.normalizePath
                        |> Seq.iter (fun entry ->
                            if results.Count < maxFiles then
                                let name = Path.GetFileName(entry)
                                if Directory.Exists(entry) then
                                    if not (ignoredDirectoryNames.Contains name) then
                                        walk rootReal entry
                                elif name.EndsWith(".cwt", StringComparison.OrdinalIgnoreCase) then
                                    match tryResolveFileSystemInfo (FileInfo(entry)) with
                                    | Some realFile when CwtProjectIndex.isPathWithin rootReal realFile ->
                                        let fileKey = CwtProjectIndex.normalizePath realFile
                                        if visitedFiles.Add(fileKey) then results.Add(realFile)
                                    | _ -> ())
                    with _ -> ()
            | _ -> ()

    match rootFull with
    | Some rootReal -> walk rootReal rootReal
    | None -> ()

    results
    |> Seq.sortBy (fun p -> CwtProjectIndex.normalizePath p)
    |> Seq.truncate maxFiles
    |> Seq.map (fun path ->
        let full = Path.GetFullPath(path)
        let overlay =
            match docs.GetText(FileInfo(full)) with
            | Some text -> Some text
            | None ->
                try Some(File.ReadAllText(full))
                with _ -> None
        full, overlay)
    |> Seq.choose (fun (p, text) -> text |> Option.map (fun t -> p, t))
    |> Seq.toList

// ------------------------------------------------------------ activation

/// Candidate rules that passed validation and are ready to swap into the
/// game model. The swap itself runs under the game-state write lock in
/// Program.fs via onActivationReady.
type CwtActivationRequest =
    { ruleRoot: string
      snapshot: CwtProjectSnapshot
      ruleFiles: (string * string) list }

/// Set by Program.fs to the write-locked game-model swap; None in CWT-only
/// mode (no game model to swap).
let mutable onActivationReady: (CwtActivationRequest -> unit) option = None

/// Program.fs supplies the runtime policy. CWT-only workspaces index rules but
/// do not activate them; game workspaces activate only their configured manual
/// rules root.
let mutable canActivateRulesFromRoot: (string -> bool) option = None

let mutable private activeRules: CwtActivation.CwtActiveRules option = None

/// Active rules identity (generation/content hash).
let activeRulesState () = activeRules

/// Records a committed activation (called by Program.fs after the swap).
let recordActivation (generation: int) (contentHash: string) =
    activeRules <- Some { CwtActivation.CwtActiveRules.generation = generation; contentHash = contentHash }

/// Decides whether the candidate may replace the active game rules and hands
/// the request to Program.fs. Rejected candidates keep last-known-good (their
/// diagnostics are already published by lint).
let private maybeRequestActivation (ruleRoot: string) (snapshot: CwtProjectSnapshot) (ruleFiles: (string * string) list) =
    let activationEnabled =
        canActivateRulesFromRoot
        |> Option.exists (fun predicate -> predicate ruleRoot)

    match activationEnabled, onActivationReady with
    | true, Some callback ->
        match CwtActivation.decideActivation snapshot ruleFiles activeRules with
        | CwtActivation.Activate ->
            lock snapshotLock (fun () -> latestActivationRejection <- None)
            callback { ruleRoot = ruleRoot; snapshot = snapshot; ruleFiles = ruleFiles }
        | CwtActivation.Rejected reason ->
            let target =
                snapshot.documents
                |> Map.toSeq
                |> Seq.map fst
                |> Seq.append snapshot.parseFailedFiles
                |> Seq.sort
                |> Seq.tryHead

            lock snapshotLock (fun () ->
                latestActivationRejection <-
                    target
                    |> Option.map (fun filePath ->
                        { version = snapshot.version
                          filePath = CwtProjectIndex.normalizePath filePath
                          reason = reason }))
        | CwtActivation.NoChange ->
            lock snapshotLock (fun () -> latestActivationRejection <- None)
    | _ ->
        lock snapshotLock (fun () -> latestActivationRejection <- None)

/// Project diagnostics for a file (CWT3xx/CWT4xx), as error tuples; [] when
/// the index is not ready (no false "undefined" reports while pending).
let projectErrorsForFile (filePath: string) : CwtErrorTuple list =
    match latestSnapshot () with
    | None -> []
    | Some snapshot ->
        let projectErrors =
            CwtProjectIndex.projectDiagnosticsForFile snapshot filePath
            |> List.map toErrorTuple

        let activationError =
            lock snapshotLock (fun () ->
                match latestActivationRejection with
                | Some rejection
                    when rejection.version = snapshot.version
                         && rejection.filePath = CwtProjectIndex.normalizePath filePath ->
                    let reason =
                        if String.IsNullOrWhiteSpace rejection.reason then "blocking diagnostics"
                        else rejection.reason
                    Some(
                        "CWT900",
                        Severity.Information,
                        filePath,
                        $"Candidate rules rejected (%s{reason}); the previous rules remain active. Fix the reported errors to retry.",
                        mkRange filePath (mkPos 1 0) (mkPos 1 1),
                        1,
                        None)
                | _ -> None)

        projectErrors @ (activationError |> Option.toList)

/// LSP range conversion (CWTools range -> LSP range).
let private toLspRange (r: range) : LSP.Types.Range =
    { start = { line = max 0 (int r.StartLine - 1); character = int r.StartColumn }
      ``end`` = { line = max 0 (int r.EndLine - 1); character = int r.EndColumn } }

let private filePathToUri (path: string) =
    Uri(Path.GetFullPath(path))

/// Finds the structured token at the cursor (`type[pl|anet_class]`,
/// `<sprite>`, `$x`) and resolves it to (kind, name, range).
let private symbolAtPosition (filePath: string) (text: string) (position: pos) : (CwtSymbolKind * string * range) option =
    let lineIdx = max 0 (position.Line - 1)
    let lineStart =
        let mutable start = 0
        let mutable line = 0
        let mutable i = 0
        while i < text.Length && line < lineIdx do
            if text.[i] = '\n' then
                line <- line + 1
                start <- i + 1
            i <- i + 1
        start
    let offset = min text.Length (lineStart + position.Column)
    if offset <= lineStart then None
    else
        let isWord c = System.Char.IsLetterOrDigit c || c = '_' || c = '.'
        let mutable startIdx = offset
        let mutable endIdx = offset
        while startIdx > lineStart && isWord text.[startIdx - 1] do startIdx <- startIdx - 1
        while endIdx < text.Length && endIdx - lineStart < position.Column + 20 && isWord text.[endIdx] do endIdx <- endIdx + 1
        let word = text.Substring(startIdx, endIdx - startIdx)
        if word = "" then None
        else
            // bracket context: `type[word]` -> kind from prefix
            let mutable bracketIdx = startIdx - 1
            let mutable prefix = ""
            let mutable valid = true
            while bracketIdx >= lineStart && valid do
                if text.[bracketIdx] = '[' then ()
                elif text.[bracketIdx] = ']' || text.[bracketIdx] = '=' || text.[bracketIdx] = '{' || text.[bracketIdx] = '}' then valid <- false
                else bracketIdx <- bracketIdx - 1
                if valid && text.[bracketIdx] <> '[' then bracketIdx <- bracketIdx - 1
            if bracketIdx >= lineStart && valid then
                let mutable p = bracketIdx - 1
                while p >= lineStart && (System.Char.IsAsciiLetterLower text.[p] || text.[p] = '_') do p <- p - 1
                prefix <- text.Substring(p + 1, bracketIdx - p - 1)
            let kind =
                match prefix with
                | "type" -> Some CwtSymbolKind.CwtType
                | "subtype" -> Some CwtSymbolKind.CwtSubtype
                | "enum" -> Some CwtSymbolKind.CwtEnum
                | "complex_enum" -> Some CwtSymbolKind.CwtComplexEnum
                | "value" | "value_set" -> Some CwtSymbolKind.CwtValueSet
                | "alias" -> Some CwtSymbolKind.CwtAlias
                | "single_alias" -> Some CwtSymbolKind.CwtSingleAlias
                | "scope" -> Some CwtSymbolKind.CwtScope
                | "scope_group" -> Some CwtSymbolKind.CwtScopeGroup
                | _ -> None
            match kind with
            | Some k when prefix <> "" ->
                Some(k, word, mkRange filePath (mkPos position.Line (startIdx - lineStart)) (mkPos position.Line (endIdx - lineStart)))
            | _ ->
                // `<word>` context -> type
                if startIdx > lineStart && text.[startIdx - 1] = '<' then
                    Some(CwtSymbolKind.CwtType, word, mkRange filePath (mkPos position.Line (startIdx - lineStart)) (mkPos position.Line (endIdx - lineStart)))
                else
                    None

/// Cross-file definition locations for the symbol at the cursor.
let definitionLocations (filePath: string) (line: int) (character: int) (text: string) : Location list =
    let position = Main.PosHelper.fromZ line character
    match latestSnapshot () with
    | None -> []
    | Some snapshot ->
        match symbolAtPosition filePath text position with
        | None -> []
        | Some(kind, name, _) ->
            CwtProjectIndex.symbolsOfKind snapshot.symbols kind
            |> Map.tryFind name
            |> Option.map (fun symbols ->
                symbols
                |> List.map (fun s ->
                    { uri = filePathToUri s.filePath
                      range = toLspRange s.range })
                |> List.sortBy (fun l -> l.uri.AbsoluteUri + string l.range.start.line + string l.range.start.character))
            |> Option.defaultValue []

/// Cross-file reference locations for the symbol at the cursor.
let referenceLocations (filePath: string) (line: int) (character: int) (text: string) : Location list =
    let position = Main.PosHelper.fromZ line character
    match latestSnapshot () with
    | None -> []
    | Some snapshot ->
        match symbolAtPosition filePath text position with
        | None -> []
        | Some(kind, name, _) ->
            snapshot.documents
            |> Map.toSeq
            |> Seq.collect (fun (_, doc) ->
                doc.references
                |> Seq.filter (fun r -> r.kind = kind && r.name = name)
                |> Seq.map (fun r ->
                    { uri = filePathToUri r.filePath
                      range = toLspRange r.range }))
            |> Seq.sortBy (fun l -> l.uri.AbsoluteUri + string l.range.start.line + string l.range.start.character)
            |> Seq.toList


let private kindToLsp (kind: string) : CompletionItemKind option =
    match kind with
    | "RootBlock" -> Some CompletionItemKind.Module
    | "Directive" -> Some CompletionItemKind.Keyword
    | "FieldExpression" -> Some CompletionItemKind.Property
    | "Symbol" -> Some CompletionItemKind.Constant
    | _ -> None

/// Last `[` on the current line before the cursor (for symbol edits).
let private linePrefixLastBracket (text: string) (lineStart: int) (offset: int) =
    let mutable idx = offset - 1
    let mutable found = -1
    while idx >= lineStart && found < 0 do
        if text.[idx] = '[' then found <- idx - lineStart
        idx <- idx - 1
    found

/// Computes the LSP edit range covering the text the user typed at the cursor
/// so accepting an item replaces it. Symbol items replace only the name inside
/// the declaration brackets; everything else replaces the whole typed prefix
/// (including `$`, `<` and `[` where present).
let private completionEdit (text: string) (line: int) (character: int) (kind: string) (newText: string) : InsertReplaceEdit =
    let lineStart =
        let mutable start = 0
        let mutable currentLine = 0
        let mutable i = 0
        while i < text.Length && currentLine < line do
            if text.[i] = '\n' then
                currentLine <- currentLine + 1
                start <- i + 1
            i <- i + 1
        start
    let offset = min text.Length (lineStart + character)
    let isWordChar c =
        System.Char.IsLetterOrDigit c || c = '_' || c = '$' || c = '<' || c = '['
    let isSymbolChar c = System.Char.IsLetterOrDigit c || c = '_'
    let mutable start = offset
    let boundary =
        if kind = "Symbol" then
            let bracketIdx = linePrefixLastBracket text lineStart offset
            if bracketIdx >= 0 then lineStart + bracketIdx + 1 else lineStart
        else
            lineStart
    while start > boundary && (if kind = "Symbol" then isSymbolChar text.[start - 1] else isWordChar text.[start - 1]) do
        start <- start - 1
    let range =
        { start = { line = line; character = start - lineStart }
          ``end`` = { line = line; character = character } }
    { insert = range; replace = range; newText = newText }

/// Dedicated completion for .cwt documents. Never reaches game.Complete;
/// returns None when the document text is unavailable (caller falls back to
/// the regular empty completion).
let complete (p: CompletionParams) (docs: DocumentStore) : CompletionList option =
    let filePath = p.textDocument.uri.LocalPath

    match docs.GetText(FileInfo(filePath)) with
    | None -> None
    | Some text ->
        let position = Main.PosHelper.fromZ p.position.line p.position.character

        let projectSymbols =
            match latestSnapshot () with
            | Some snapshot ->
                snapshot.documents
                |> Map.toSeq
                |> Seq.collect (fun (_, doc) -> doc.symbols)
                |> Seq.toList
            | None -> []

        let items =
            CwtLanguageService.completeAtWithProject filePath text position (Some projectSymbols)
            |> List.map (fun item ->
                { defaultCompletionItem with
                    label = item.label
                    kind = kindToLsp item.kind
                    detail = item.detail
                    documentation =
                        item.documentation
                        |> Option.map (fun doc -> { kind = MarkupKind.PlainText; value = doc })
                    sortText = Some("00000" + item.label)
                    filterText = Some item.label
                    // textEdit must be present: the client reads its range and
                    // crashes on a serialized `null` textEdit.
                    textEdit =
                        Some(completionEdit text p.position.line p.position.character item.kind item.label) })

        Some { isIncomplete = false; items = items }



let private rebuildLock = obj()
let mutable private pendingRebuild: CancellationTokenSource option = None

/// Debounced, versioned snapshot rebuild. A new request cancels the pending
/// delay, and publication still checks the latest requested version to guard
/// against a build that was already running when cancellation arrived.
let requestSnapshotRebuild (root: string) (docs: DocumentStore) (debounceMs: int) =
    let version = nextSnapshotVersion ()
    let cancellation = new CancellationTokenSource()

    lock rebuildLock (fun () ->
        pendingRebuild |> Option.iter (fun previous -> previous.Cancel())
        pendingRebuild <- Some cancellation)

    let rebuild =
        async {
            try
                do! Async.Sleep(debounceMs)
                cancellation.Token.ThrowIfCancellationRequested()
                let files = enumerateCwtFiles root docs CwtProjectIndex.defaultMaxFiles
                cancellation.Token.ThrowIfCancellationRequested()
                let snapshot =
                    CwtProjectIndex.buildSnapshot
                        version
                        CwtProjectIndex.defaultMaxFiles
                        CwtProjectIndex.defaultMaxFileSizeBytes
                        root
                        files

                if publishSnapshot snapshot then
                    maybeRequestActivation root snapshot files
            finally
                lock rebuildLock (fun () ->
                    match pendingRebuild with
                    | Some current when Object.ReferenceEquals(current, cancellation) -> pendingRebuild <- None
                    | _ -> ())
                cancellation.Dispose()
        }

    Async.Start(rebuild, cancellationToken = cancellation.Token)
