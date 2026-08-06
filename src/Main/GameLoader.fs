module Main.Lang.GameLoader

open LSP.Types
open System
open CWTools.Games
open System.IO
open CWTools.Games.Files
open Main.Serialize
open CWTools.Utilities.Utils
open System.Text.Json

// Store vanilla scripted variables path for hover (set after game load)
let mutable stlVanillaScriptedVarsPath: string option = None
let mutable stlGameVersion: string option = None

let tryReadStellarisGameVersion (vanillaPath: string) =
    let launcherSettings = System.IO.Path.Combine(vanillaPath, "launcher-settings.json")

    if not (System.IO.File.Exists launcherSettings) then
        None
    else
        try
            use document = JsonDocument.Parse(System.IO.File.ReadAllText launcherSettings)
            let mutable rawVersion = Unchecked.defaultof<JsonElement>

            if
                document.RootElement.TryGetProperty("rawVersion", &rawVersion)
                && rawVersion.ValueKind = JsonValueKind.String
            then
                rawVersion.GetString()
                |> Option.ofObj
                |> Option.map (fun value -> value.Trim().TrimStart('v', 'V'))
                |> Option.filter (String.IsNullOrWhiteSpace >> not)
            else
                None
        with ex ->
            logWarning (sprintf "GameLoader: failed to read Stellaris version from %s: %s" launcherSettings ex.Message)
            None

let rec replaceFirst predicate value =
    function
    | [] -> []
    | h :: t when predicate h -> value :: t
    | h :: t -> h :: replaceFirst predicate value t

let fixEmbeddedFileName (s: string) =
    let count = (Seq.filter ((=) '.') >> Seq.length) s
    let mutable out = "//" + s

    [ 1 .. count - 1 ]
    |> List.iter (fun _ -> out <- (replaceFirst ((=) '.') '\\' (out |> List.ofSeq)) |> Array.ofList |> String)

    out

let rec getAllFolders dirs =
    if Seq.isEmpty dirs then
        Seq.empty
    else
        seq {
            yield!
                dirs
                |> Seq.collect (fun s ->
                    try
                        Directory.EnumerateDirectories s
                    with _ ->
                        Seq.empty)

            yield!
                dirs
                |> Seq.collect (fun s ->
                    try
                        Directory.EnumerateDirectories s
                    with _ ->
                        Seq.empty)
                |> getAllFolders
        }

let getAllFoldersUnion dirs =
    seq {
        yield! dirs
        yield! getAllFolders dirs
    }

let private getRuleFilesFromFolder folder =
    if Directory.Exists folder then
        (getAllFoldersUnion ([ folder ] |> Seq.ofList))
        |> Seq.collect (fun s ->
            try
                Directory.EnumerateFiles s
            with _ ->
                Seq.empty)
        |> List.ofSeq
        |> List.filter (fun f -> Path.GetExtension f = ".cwt" || Path.GetExtension f = ".log")
    else
        []

let private getRuleFilesFromZip (zipPath: string) : (string * string) list =
    if not (File.Exists zipPath) then
        []
    else
        try
            use archive = System.IO.Compression.ZipFile.OpenRead(zipPath)
            archive.Entries
            |> Seq.filter (fun entry ->
                let ext = Path.GetExtension(entry.FullName)
                (ext = ".cwt" || ext = ".log") && entry.Length > 0L)
            |> Seq.map (fun entry ->
                use stream = entry.Open()
                use reader = new System.IO.StreamReader(stream)
                let content = reader.ReadToEnd()
                entry.FullName, content)
            |> List.ofSeq
        with e ->
            logInfo $"Failed to read bundled rules ZIP %s{zipPath}: %A{e}"
            []

let private readConfigFiles configFiles =
    configFiles |> List.map (fun f -> f, File.ReadAllText(f))

let private resolveConfigFiles cachePath useManualRules manualRulesFolder bundledRulesFolder preferBundledRules =
    let manualConfigFiles =
        match useManualRules, manualRulesFolder with
        | true, Some rf when Directory.Exists rf -> getRuleFilesFromFolder rf
        | _ -> []

    let cachedConfigFiles =
        match cachePath, useManualRules with
        | Some path, false -> getRuleFilesFromFolder path
        | _ -> []

    let bundledConfigFiles : (string * string) list =
        match bundledRulesFolder, useManualRules with
        | Some (path: string), false when path.EndsWith(".zip", System.StringComparison.OrdinalIgnoreCase) ->
            getRuleFilesFromZip path
        | Some path, false -> readConfigFiles (getRuleFilesFromFolder path)
        | _ -> []

    let useBundledFallback =
        preferBundledRules
        && not useManualRules
        && bundledConfigFiles.Length > 0

    if manualConfigFiles.Length > 0 then readConfigFiles manualConfigFiles, "manual"
    elif useManualRules then [], "missing"
    elif useBundledFallback then bundledConfigFiles, "bundled"
    elif cachedConfigFiles.Length > 0 then readConfigFiles cachedConfigFiles, "remote"
    else [], "missing"

let getConfigFiles cachePath useManualRules manualRulesFolder bundledRulesFolder preferBundledRules =
    resolveConfigFiles cachePath useManualRules manualRulesFolder bundledRulesFolder preferBundledRules
    |> fst

let getConfigSource cachePath useManualRules manualRulesFolder bundledRulesFolder preferBundledRules =
    resolveConfigFiles cachePath useManualRules manualRulesFolder bundledRulesFolder preferBundledRules
    |> snd

/// Automatic mode starts from a packaged fallback when one is available so
/// project loading never waits for the remote rules check. Manual mode remains
/// isolated from both bundled and remote rules.
let shouldPreferBundledRulesAtStartup useManualRules =
    not useManualRules

/// Once the remote check completes, preserve the existing final-source policy:
/// a successful check selects the remote cache, while a failed check selects
/// the bundled fallback (and resolveConfigFiles falls back to the cache if the
/// bundle is unavailable).
let shouldPreferBundledRulesAfterRemoteUpdate useManualRules remoteUpdateSucceeded =
    not useManualRules && not remoteUpdateSucceeded

let getFolderList (filename: string, filetext: string) =
    if Path.GetFileName filename = "folders.cwt" then
        Some(filetext.Split([| "\r\n"; "\r"; "\n" |], StringSplitOptions.RemoveEmptyEntries ||| StringSplitOptions.TrimEntries))
    else
        None

type ServerSettings =
    { cachePath: string option
      bundledRulesPath: string option
      preferBundledRules: bool
      useManualRules: bool
      manualRulesFolder: string option
      isVanillaFolder: bool
      path: string
      workspaceFolders: WorkspaceFolder list
      dontLoadPatterns: string array
      validateVanilla: bool
      languages: CWTools.Common.Lang array
      experimental: bool
      debug_mode: bool
      maxFileSize: int
      stlVanillaPath: string option }

type GameLanguage =
    | STL
    | HOI4
    | EU4
    | CK2
    | IR
    | VIC2
    | CK3
    | VIC3
    | EU5
    | Custom

let private gameCacheFile (cp: string) (fileName: string) =
    let parent = System.IO.Directory.GetParent(cp)
    let dir = if parent <> null then parent.FullName else cp + "/.."
    System.IO.Path.Combine(dir, fileName)

let private loadCacheIfPresent cacheFile =
    if System.IO.File.Exists cacheFile then
        deserialize cacheFile
    else
        logInfo $"Cache file not found at %s{cacheFile}; continuing without vanilla cache"
        ([], [])

let getCachedFiles (game: GameLanguage) cachePath isVanillaFolder =
    let timer = System.Diagnostics.Stopwatch()
    timer.Start()

    let cached, cachedFiles =
        match (game, cachePath, isVanillaFolder) with
        | _, _, true ->
            logInfo "Vanilla folder, so not loading cache"
            ([], [])
        | STL, Some cp, _ -> loadCacheIfPresent (gameCacheFile cp "stl.cwb")
        | EU4, Some cp, _ -> loadCacheIfPresent (gameCacheFile cp "eu4.cwb")
        | EU5, Some cp, _ -> loadCacheIfPresent (gameCacheFile cp "eu5.cwb")
        | HOI4, Some cp, _ -> loadCacheIfPresent (gameCacheFile cp "hoi4.cwb")
        | CK2, Some cp, _ -> loadCacheIfPresent (gameCacheFile cp "ck2.cwb")
        | IR, Some cp, _ -> loadCacheIfPresent (gameCacheFile cp "ir.cwb")
        | VIC2, Some cp, _ -> loadCacheIfPresent (gameCacheFile cp "vic2.cwb")
        | VIC3, Some cp, _ -> loadCacheIfPresent (gameCacheFile cp "vic3.cwb")
        | CK3, Some cp, _ -> loadCacheIfPresent (gameCacheFile cp "ck3.cwb")
        | _ -> ([], [])

    logInfo $"Parse cache time: %i{timer.ElapsedMilliseconds}ms, cached resources: %d{List.length cached}, cached files: %d{List.length cachedFiles}"
    timer.Restart()
    cached, cachedFiles


let getRootDirectories (serverSettings: ServerSettings) =
    let rawdirs =
        match serverSettings.workspaceFolders with
        | [] ->
            [ { WorkspaceDirectory.name = Path.GetFileName serverSettings.path
                path = serverSettings.path } ]
        | ws ->
            ws
            |> List.map (fun wd ->
                { WorkspaceDirectory.name = wd.name
                  path = wd.uri.LocalPath })
    let rawdirs = rawdirs |> Array.ofList
    rawdirs
    |> Array.map (fun directory -> directory.name, directory.path)
    |> Array.toList
    |> PdxShaderProject.configureLoadOrderRoots
    Array.concat
        [ rawdirs |> Array.map WD;
            rawdirs |> Array.collect (CWTools.Serializer.addDLCs "dlc");
            rawdirs |> Array.collect (CWTools.Serializer.addDLCs "integrated_dlc") ]


let loadEU4 (serverSettings: ServerSettings) =
    let cached, cachedFiles =
        getCachedFiles EU4 serverSettings.cachePath serverSettings.isVanillaFolder

    let configs =
        getConfigFiles serverSettings.cachePath serverSettings.useManualRules serverSettings.manualRulesFolder serverSettings.bundledRulesPath serverSettings.preferBundledRules

    let folders = configs |> List.tryPick getFolderList

    // let eu4Mods = EU4Parser.loadModifiers "eu4mods" ((new StreamReader(Assembly.GetEntryAssembly().GetManifestResourceStream(eu4modpath))).ReadToEnd())
    let eu4settings =
        { rootDirectories = getRootDirectories serverSettings
          scriptFolders = folders
          excludeGlobPatterns = Some serverSettings.dontLoadPatterns
          embedded = FromConfig(cachedFiles, cached)
          validation =
            { validateVanilla = serverSettings.validateVanilla
              langs = serverSettings.languages
              experimental = serverSettings.experimental }
          rules =
            Some
                { ruleFiles = configs
                  validateRules = true
                  debugRulesOnly = false
                  debugMode = serverSettings.debug_mode }
          modFilter = None
          debugSettings = DebugSettings.Default
          maxFileSize = Some serverSettings.maxFileSize
          vanillaPath = None }

    let game = CWTools.Games.EU4.EU4Game(eu4settings)
    game


let loadHOI4 serverSettings =
    let cached, cachedFiles =
        getCachedFiles HOI4 serverSettings.cachePath serverSettings.isVanillaFolder

    let configs =
        getConfigFiles serverSettings.cachePath serverSettings.useManualRules serverSettings.manualRulesFolder serverSettings.bundledRulesPath serverSettings.preferBundledRules

    let folders = configs |> List.tryPick getFolderList

    let _ = "Main.files.hoi4.modifiers"

    let hoi4settings =
        { rootDirectories = getRootDirectories serverSettings
          scriptFolders = folders
          excludeGlobPatterns = Some serverSettings.dontLoadPatterns
          embedded = FromConfig(cachedFiles, cached)
          validation =
            { validateVanilla = serverSettings.validateVanilla
              langs = serverSettings.languages
              experimental = serverSettings.experimental }
          rules =
            Some
                { ruleFiles = configs
                  validateRules = true
                  debugRulesOnly = false
                  debugMode = serverSettings.debug_mode }
          modFilter = None
          debugSettings = DebugSettings.Default
          maxFileSize = Some serverSettings.maxFileSize
          vanillaPath = None }

    let game = CWTools.Games.HOI4.HOI4Game(hoi4settings)
    game

let loadCK2 serverSettings =
    let cached, cachedFiles =
        getCachedFiles CK2 serverSettings.cachePath serverSettings.isVanillaFolder

    let configs =
        getConfigFiles serverSettings.cachePath serverSettings.useManualRules serverSettings.manualRulesFolder serverSettings.bundledRulesPath serverSettings.preferBundledRules

    let folders = configs |> List.tryPick getFolderList


    // let ck2Mods = CK2Parser.loadModifiers "ck2mods" ((new StreamReader(Assembly.GetEntryAssembly().GetManifestResourceStream(ck2modpath))).ReadToEnd())
    let ck2settings =
        { rootDirectories = getRootDirectories serverSettings
          scriptFolders = folders
          excludeGlobPatterns = Some serverSettings.dontLoadPatterns
          embedded = FromConfig(cachedFiles, cached)
          validation =
            { validateVanilla = serverSettings.validateVanilla
              langs = serverSettings.languages
              experimental = serverSettings.experimental }
          rules =
            Some
                { ruleFiles = configs
                  validateRules = true
                  debugRulesOnly = false
                  debugMode = serverSettings.debug_mode }
          modFilter = None
          debugSettings = DebugSettings.Default
          maxFileSize = Some serverSettings.maxFileSize
          vanillaPath = None }

    let game = CWTools.Games.CK2.CK2Game(ck2settings)
    game

let loadIR serverSettings =
    let cached, cachedFiles =
        getCachedFiles IR serverSettings.cachePath serverSettings.isVanillaFolder

    let configs =
        getConfigFiles serverSettings.cachePath serverSettings.useManualRules serverSettings.manualRulesFolder serverSettings.bundledRulesPath serverSettings.preferBundledRules

    let folders = configs |> List.tryPick getFolderList



    // let ck2Mods = CK2Parser.loadModifiers "ck2mods" ((new StreamReader(Assembly.GetEntryAssembly().GetManifestResourceStream(ck2modpath))).ReadToEnd())
    let irsettings =
        { rootDirectories = getRootDirectories serverSettings
          scriptFolders = folders
          excludeGlobPatterns = Some serverSettings.dontLoadPatterns
          embedded = FromConfig(cachedFiles, cached)
          validation =
            { validateVanilla = serverSettings.validateVanilla
              langs = serverSettings.languages
              experimental = serverSettings.experimental }
          rules =
            Some
                { ruleFiles = configs
                  validateRules = true
                  debugRulesOnly = false
                  debugMode = serverSettings.debug_mode }
          modFilter = None
          debugSettings = DebugSettings.Default
          maxFileSize = Some serverSettings.maxFileSize
          vanillaPath = None }

    let game = CWTools.Games.IR.IRGame(irsettings)
    game

let loadVIC2 serverSettings =
    let cached, cachedFiles =
        getCachedFiles VIC2 serverSettings.cachePath serverSettings.isVanillaFolder

    let configs =
        getConfigFiles serverSettings.cachePath serverSettings.useManualRules serverSettings.manualRulesFolder serverSettings.bundledRulesPath serverSettings.preferBundledRules

    let folders = configs |> List.tryPick getFolderList


    let vic2settings =
        { rootDirectories = getRootDirectories serverSettings
          scriptFolders = folders
          excludeGlobPatterns = Some serverSettings.dontLoadPatterns
          embedded = FromConfig(cachedFiles, cached)
          validation =
            { validateVanilla = serverSettings.validateVanilla
              langs = serverSettings.languages
              experimental = serverSettings.experimental }
          rules =
            Some
                { ruleFiles = configs
                  validateRules = true
                  debugRulesOnly = false
                  debugMode = serverSettings.debug_mode }
          modFilter = None
          debugSettings = DebugSettings.Default
          maxFileSize = Some serverSettings.maxFileSize
          vanillaPath = None }

    let game = CWTools.Games.VIC2.VIC2Game(vic2settings)
    game

let loadSTL serverSettings =
    stlGameVersion <- None
    let cached, cachedFiles =
        getCachedFiles STL serverSettings.cachePath serverSettings.isVanillaFolder

    let configs =
        getConfigFiles serverSettings.cachePath serverSettings.useManualRules serverSettings.manualRulesFolder serverSettings.bundledRulesPath serverSettings.preferBundledRules

    let folders = configs |> List.tryPick getFolderList

    let timer = System.Diagnostics.Stopwatch()
    timer.Start()

    let stlsettings =
        { CWTools.Games.Stellaris.StellarisSettings.rootDirectories = getRootDirectories serverSettings
          modFilter = None
          scriptFolders = folders
          excludeGlobPatterns = Some serverSettings.dontLoadPatterns
          validation =
            { validateVanilla = serverSettings.validateVanilla
              experimental = serverSettings.experimental
              langs = serverSettings.languages }
          rules =
            Some
                { ruleFiles = configs
                  validateRules = true
                  debugRulesOnly = false
                  debugMode = serverSettings.debug_mode }
          embedded = FromConfig(cachedFiles, cached)
          debugSettings = DebugSettings.Default
          maxFileSize = Some serverSettings.maxFileSize
          vanillaPath = serverSettings.stlVanillaPath }

    let game = CWTools.Games.Stellaris.STLGame(stlsettings)
    
    // Set vanilla scripted variables path for hover and load vanilla FX shader sources
    match serverSettings.stlVanillaPath with
    | Some vp ->
        stlVanillaScriptedVarsPath <- Some(System.IO.Path.Combine(vp, "common", "scripted_variables"))
        stlGameVersion <- tryReadStellarisGameVersion vp
        CWTools.Games.PdxShaderFeatures.loadVanillaFxSources vp
    | None -> ()

    // Load version-bound shader ABI evidence shipped with the Stellaris rules.
    // launcher-settings.json supplies the active game version; missing/mismatched
    // versions fail closed and cannot classify Effects.
    CWTools.Games.PdxShaderRuntime.resetShaderAbiCatalog ()
    CWTools.Games.PdxShaderRuntime.resetShaderAbiAudit ()
    CWTools.Games.PdxShaderRuntime.resetSpriteRendererContracts ()

    configs
    |> List.tryPick (fun (path, _) ->
        let normalized = path.Replace('\\', '/')
        let marker = normalized.LastIndexOf("/config/", StringComparison.Ordinal)
        if marker >= 0 then Some(normalized.Substring(0, marker + "/config".Length)) else None)
    |> Option.iter (fun configDir ->
        let catalogPath = System.IO.Path.Combine(configDir, "shader", "abi-catalog.json")
        if System.IO.File.Exists catalogPath then
            CWTools.Games.PdxShaderRuntime.loadShaderAbiCatalog stlGameVersion catalogPath

        let abiAuditPath = System.IO.Path.Combine(configDir, "shader", "abi-audit.json")
        if System.IO.File.Exists abiAuditPath then
            CWTools.Games.PdxShaderRuntime.loadShaderAbiAudit stlGameVersion abiAuditPath

        let rendererContractsPath = System.IO.Path.Combine(configDir, "shader", "renderer-contracts.json")
        if System.IO.File.Exists rendererContractsPath then
            CWTools.Games.PdxShaderRuntime.loadSpriteRendererContracts stlGameVersion rendererContractsPath)

    game

let loadCK3 serverSettings =
    let cached, cachedFiles =
        getCachedFiles CK3 serverSettings.cachePath serverSettings.isVanillaFolder

    let configs =
        getConfigFiles serverSettings.cachePath serverSettings.useManualRules serverSettings.manualRulesFolder serverSettings.bundledRulesPath serverSettings.preferBundledRules

    let folders = configs |> List.tryPick getFolderList



    let stlsettings =
        { CWTools.Games.CK3.CK3Settings.rootDirectories = getRootDirectories serverSettings
          modFilter = None
          scriptFolders = folders
          excludeGlobPatterns = Some serverSettings.dontLoadPatterns
          validation =
            { validateVanilla = serverSettings.validateVanilla
              experimental = serverSettings.experimental
              langs = serverSettings.languages }
          rules =
            Some
                { ruleFiles = configs
                  validateRules = true
                  debugRulesOnly = false
                  debugMode = serverSettings.debug_mode }
          embedded = FromConfig(cachedFiles, cached)
          debugSettings = DebugSettings.Default
          maxFileSize = Some serverSettings.maxFileSize
          vanillaPath = None }

    let game = CWTools.Games.CK3.CK3Game(stlsettings)
    game



let loadVIC3 serverSettings =
    let cached, cachedFiles =
        getCachedFiles VIC3 serverSettings.cachePath serverSettings.isVanillaFolder

    let configs =
        getConfigFiles serverSettings.cachePath serverSettings.useManualRules serverSettings.manualRulesFolder serverSettings.bundledRulesPath serverSettings.preferBundledRules

    let folders = configs |> List.tryPick getFolderList



    let stlsettings =
        { CWTools.Games.VIC3.VIC3Settings.rootDirectories = getRootDirectories serverSettings
          modFilter = None
          scriptFolders = folders
          excludeGlobPatterns = Some serverSettings.dontLoadPatterns
          validation =
            { validateVanilla = serverSettings.validateVanilla
              experimental = serverSettings.experimental
              langs = serverSettings.languages }
          rules =
            Some
                { ruleFiles = configs
                  validateRules = true
                  debugRulesOnly = false
                  debugMode = serverSettings.debug_mode }
          embedded = FromConfig(cachedFiles, cached)
          debugSettings = DebugSettings.Default
          maxFileSize = Some serverSettings.maxFileSize
          vanillaPath = None }

    let game = CWTools.Games.VIC3.VIC3Game(stlsettings)
    game

let loadEU5 serverSettings =
    let cached, cachedFiles =
        getCachedFiles EU5 serverSettings.cachePath serverSettings.isVanillaFolder

    let configs =
        getConfigFiles serverSettings.cachePath serverSettings.useManualRules serverSettings.manualRulesFolder serverSettings.bundledRulesPath serverSettings.preferBundledRules

    let folders = configs |> List.tryPick getFolderList



    let stlsettings =
        { CWTools.Games.EU5.EU5Settings.rootDirectories = getRootDirectories serverSettings
          modFilter = None
          scriptFolders = folders
          excludeGlobPatterns = Some serverSettings.dontLoadPatterns
          validation =
            { validateVanilla = serverSettings.validateVanilla
              experimental = serverSettings.experimental
              langs = serverSettings.languages }
          rules =
            Some
                { ruleFiles = configs
                  validateRules = true
                  debugRulesOnly = false
                  debugMode = serverSettings.debug_mode }
          embedded = FromConfig(cachedFiles, cached)
          debugSettings = DebugSettings.Default
          maxFileSize = Some serverSettings.maxFileSize
          vanillaPath = None }

    let game = CWTools.Games.EU5.EU5Game(stlsettings)
    game

let loadCustom serverSettings =
    // let cached, cachedFiles = getCachedFiles STL serverSettings.cachePath serverSettings.isVanillaFolder
    let configs =
        getConfigFiles serverSettings.cachePath serverSettings.useManualRules serverSettings.manualRulesFolder serverSettings.bundledRulesPath serverSettings.preferBundledRules

    let folders = configs |> List.tryPick getFolderList



    let stlsettings =
        { CWTools.Games.Custom.CustomSettings.rootDirectories = getRootDirectories serverSettings
          modFilter = None
          scriptFolders = folders
          excludeGlobPatterns = Some serverSettings.dontLoadPatterns
          validation =
            { validateVanilla = serverSettings.validateVanilla
              experimental = serverSettings.experimental
              langs = serverSettings.languages }
          rules =
            Some
                { ruleFiles = configs
                  validateRules = true
                  debugRulesOnly = false
                  debugMode = serverSettings.debug_mode }
          embedded = FromConfig([], [])
          debugSettings = DebugSettings.Default
          maxFileSize = Some serverSettings.maxFileSize
          vanillaPath = None }

    let game = CWTools.Games.Custom.CustomGame(stlsettings, "custom")
    game
