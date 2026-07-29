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
    assertSelection "bundled" (Some cache) false None (Some bundled) true
    assertSelection "remote" (Some cache) false None (Some bundled) false

    writeRule manual "manual.cwt"
    assertSelection "manual" (Some cache) true (Some manual) (Some bundled) true

    ZipFile.CreateFromDirectory(bundled, bundledZip)
    Directory.Delete(bundled, true)
    Directory.Delete(cache, true)
    assertSelection "bundled" (Some cache) false None (Some bundledZip) true
finally
    if Directory.Exists(root) then
        Directory.Delete(root, true)
