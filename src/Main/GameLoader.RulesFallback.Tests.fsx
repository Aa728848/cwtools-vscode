#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/LibGit2Sharp.dll"

open System
open System.IO
open System.IO.Compression
open LibGit2Sharp
open Main.Lang.GameLoader

let root = Path.Combine(Path.GetTempPath(), $"cwtools-rules-fallback-{Guid.NewGuid():N}")
let cache = Path.Combine(root, "cache")
let manual = Path.Combine(root, "manual")
let bundled = Path.Combine(root, "bundled")
let bundledZip = Path.Combine(root, "bundled.zip")
let gameCacheDirectory = Path.Combine(root, "game-cache")

let writeRule folder name =
    Directory.CreateDirectory(folder) |> ignore
    File.WriteAllText(Path.Combine(folder, name), "types = { }")

let markGitCheckout folder =
    Repository.Init(folder) |> ignore

let writeCachedRule name =
    writeRule cache name
    markGitCheckout cache

let assertSelection expected cachePath useManualRules manualRulesFolder bundledRulesPath preferBundledRules =
    let actualSource =
        getConfigSource cachePath useManualRules manualRulesFolder bundledRulesPath preferBundledRules
    let configs =
        getConfigFiles cachePath useManualRules manualRulesFolder bundledRulesPath preferBundledRules

    if actualSource <> expected then
        failwith $"Expected rules source '%s{expected}', got '%s{actualSource}'."

    if expected <> "missing" && configs.IsEmpty then
        failwith $"Rules source '%s{expected}' was selected without loading any rules."

try
    writeRule bundled "fallback.cwt"

    // Before the first successful checkout there is no cached remote source,
    // so startup uses the bundled fallback and can load immediately.
    let firstRunStartupPreference = shouldPreferBundledRulesAtStartup false (Some cache)
    if not firstRunStartupPreference then
        failwith "Automatic startup without a cached checkout should prefer bundled rules."
    assertSelection "bundled" (Some cache) false None (Some bundled) firstRunStartupPreference

    if shouldReloadWorkspaceAfterRulesUpdate true then
        failwith "A live game model should hot-swap updated rules instead of reloading the workspace."
    if not (shouldReloadWorkspaceAfterRulesUpdate false) then
        failwith "Missing game models must still trigger a full workspace load after rules arrive."

    Directory.CreateDirectory(cache) |> ignore
    File.WriteAllText(Path.Combine(cache, "failed-update.log"), "clone failed")
    markGitCheckout cache
    let logOnlyStartupPreference = shouldPreferBundledRulesAtStartup false (Some cache)
    if not logOnlyStartupPreference then
        failwith "Automatic startup with only cache logs should prefer bundled rules."
    assertSelection "bundled" (Some cache) false None (Some bundled) logOnlyStartupPreference

    Directory.Delete(cache, true)
    writeRule cache "partial.cwt"
    let nonCheckoutStartupPreference = shouldPreferBundledRulesAtStartup false (Some cache)
    if not nonCheckoutStartupPreference then
        failwith "Automatic startup with a non-checkout cache should prefer bundled rules."
    assertSelection "bundled" (Some cache) false None (Some bundled) nonCheckoutStartupPreference

    Directory.Delete(cache, true)
    writeCachedRule "cached.cwt"
    // A cached checkout is already local: prefer it at startup so the
    // background remote check does not force a second workspace reload just
    // to switch back to the same source.
    let startupPreference = shouldPreferBundledRulesAtStartup false (Some cache)
    if startupPreference then
        failwith "Automatic startup with a cached checkout should not prefer bundled rules."
    assertSelection "remote" (Some cache) false None (Some bundled) startupPreference

    let successfulUpdatePreference = shouldPreferBundledRulesAfterRemoteUpdate false true (Some cache)
    if successfulUpdatePreference then
        failwith "A successful remote update should select the remote cache."
    assertSelection "remote" (Some cache) false None (Some bundled) successfulUpdatePreference

    let failedUpdateWithCachePreference = shouldPreferBundledRulesAfterRemoteUpdate false false (Some cache)
    if failedUpdateWithCachePreference then
        failwith "A failed remote update should keep using a usable cached checkout instead of reloading bundled rules."
    assertSelection "remote" (Some cache) false None (Some bundled) failedUpdateWithCachePreference

    let failedUpdateWithoutCachePreference = shouldPreferBundledRulesAfterRemoteUpdate false false None
    if not failedUpdateWithoutCachePreference then
        failwith "A failed remote update without a cached checkout should retain the bundled fallback preference."
    assertSelection "bundled" None false None (Some bundled) failedUpdateWithoutCachePreference

    writeRule manual "manual.cwt"
    let manualStartupPreference = shouldPreferBundledRulesAtStartup true (Some cache)
    let manualFinalPreference = shouldPreferBundledRulesAfterRemoteUpdate true false (Some cache)
    if manualStartupPreference || manualFinalPreference then
        failwith "Manual mode must never prefer bundled rules."
    assertSelection "manual" (Some cache) true (Some manual) (Some bundled) manualStartupPreference

    ZipFile.CreateFromDirectory(bundled, bundledZip)
    Directory.Delete(bundled, true)
    Directory.Delete(cache, true)
    let zipStartupPreference = shouldPreferBundledRulesAtStartup false (Some cache)
    if not zipStartupPreference then
        failwith "Automatic startup without a cached checkout should prefer the bundled ZIP rules."
    assertSelection "bundled" (Some cache) false None (Some bundledZip) zipStartupPreference
    
    let zipConfigs =
        getConfigFiles (Some cache) false None (Some bundledZip) true
    if zipConfigs.IsEmpty then
        failwith "Bundled ZIP rules were selected without loading any rules."
    if zipConfigs |> List.exists (fun (path, _) -> not (File.Exists path)) then
        failwith "Bundled ZIP rules must be materialized to real files on disk."

    Directory.CreateDirectory(gameCacheDirectory) |> ignore
    let missingResources, missingFiles = getCachedFiles STL (Some gameCacheDirectory) false

    if not missingResources.IsEmpty || not missingFiles.IsEmpty then
        failwith "A missing vanilla cache should fall back to empty cached resources and files."
finally
    if Directory.Exists(root) then
        Directory.Delete(root, true)
