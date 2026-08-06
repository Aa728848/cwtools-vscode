#r "../../submodules/cwtools/artifacts/bin/CWTools/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/CWTools Server.dll"

open System
open System.IO
open System.IO.Compression
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

    assertSelection "bundled" (Some cache) false None (Some bundled) true

    writeRule cache "cached.cwt"
    let startupPreference = shouldPreferBundledRulesAtStartup false
    if not startupPreference then
        failwith "Automatic startup should prefer bundled rules while the remote check runs."
    assertSelection "bundled" (Some cache) false None (Some bundled) startupPreference

    let successfulUpdatePreference = shouldPreferBundledRulesAfterRemoteUpdate false true
    if successfulUpdatePreference then
        failwith "A successful remote update should select the remote cache."
    assertSelection "remote" (Some cache) false None (Some bundled) successfulUpdatePreference

    let failedUpdatePreference = shouldPreferBundledRulesAfterRemoteUpdate false false
    if not failedUpdatePreference then
        failwith "A failed remote update should retain the bundled fallback preference."
    assertSelection "bundled" (Some cache) false None (Some bundled) failedUpdatePreference

    writeRule manual "manual.cwt"
    let manualStartupPreference = shouldPreferBundledRulesAtStartup true
    let manualFinalPreference = shouldPreferBundledRulesAfterRemoteUpdate true false
    if manualStartupPreference || manualFinalPreference then
        failwith "Manual mode must never prefer bundled rules."
    assertSelection "manual" (Some cache) true (Some manual) (Some bundled) manualStartupPreference

    ZipFile.CreateFromDirectory(bundled, bundledZip)
    Directory.Delete(bundled, true)
    Directory.Delete(cache, true)
    assertSelection "bundled" (Some cache) false None (Some bundledZip) true

    Directory.CreateDirectory(gameCacheDirectory) |> ignore
    let missingResources, missingFiles = getCachedFiles STL (Some gameCacheDirectory) false

    if not missingResources.IsEmpty || not missingFiles.IsEmpty then
        failwith "A missing vanilla cache should fall back to empty cached resources and files."
finally
    if Directory.Exists(root) then
        Directory.Delete(root, true)
