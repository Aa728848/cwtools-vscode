#load "OverlayValidation.fs"

open System
open System.IO
open Main.OverlayValidation

let assertEqual name expected actual =
    if expected <> actual then failwithf "%s: expected %A, got %A" name expected actual

assertEqual "accept" [| Accept; Accept |] (admit [| "a.txt", 1; "b.txt", 2 |])
assertEqual "duplicate" [| Accept; Duplicate |] (admit [| "a.txt", 1; "a.txt", 1 |])
assertEqual "single exact production boundary" [| Accept |] (admit [| "a.txt", MaxFileChars |])
assertEqual "single oversized" [| Oversized |] (admit [| "a.txt", MaxFileChars + 1 |])
assertEqual
    "total exact production boundary"
    [| Accept; Accept; Accept; Accept |]
    (admit [| "a.txt", MaxFileChars; "b.txt", MaxFileChars; "c.txt", MaxFileChars; "d.txt", MaxFileChars |])
assertEqual "total oversized" [| Accept; Accept; Accept; Accept; Oversized |] (admit [| "a.txt", MaxFileChars; "b.txt", MaxFileChars; "c.txt", MaxFileChars; "d.txt", MaxFileChars; "e.txt", 1 |])
let exactFileLimit = Array.init MaxFiles (fun index -> string index, 0)
assertEqual "exact production file boundary" (Array.create MaxFiles Accept) (admit exactFileLimit)
let many = Array.init (MaxFiles + 1) (fun index -> string index, 0)
assertEqual "truncated" Truncated (admit many).[MaxFiles]

let tempRoot = Path.Combine(Path.GetTempPath(), "cwtools-overlay-containment-" + Guid.NewGuid().ToString("N"))
let workspace = Path.Combine(tempRoot, "workspace")
let outside = Path.Combine(tempRoot, "outside")
Directory.CreateDirectory(workspace) |> ignore
Directory.CreateDirectory(outside) |> ignore
try
    let existing = Path.Combine(workspace, "existing.txt")
    File.WriteAllText(existing, "ok")
    assertEqual "existing target inside" true (isPathWithinResolvedRoot workspace existing)
    assertEqual "nearest existing parent inside" true (isPathWithinResolvedRoot workspace (Path.Combine(workspace, "new", "file.txt")))
    assertEqual "nearest existing parent outside" false (isPathWithinResolvedRoot workspace (Path.Combine(outside, "new.txt")))

    let link = Path.Combine(workspace, "escape")
    try
        Directory.CreateSymbolicLink(link, outside) |> ignore
        assertEqual "existing reparse target escape" false (isPathWithinResolvedRoot workspace link)
        assertEqual "nearest existing reparse parent escape" false (isPathWithinResolvedRoot workspace (Path.Combine(link, "new.txt")))
    with :? UnauthorizedAccessException ->
        printfn "Skipping reparse containment assertions: symbolic links are unavailable"

    if OperatingSystem.IsWindows() then
        assertEqual "device UNC normalization" @"\\server\share\file.txt" (normalizeResolvedPath @"\\?\UNC\server\share\file.txt")
finally
    try Directory.Delete(tempRoot, true) with _ -> ()

printfn "Overlay validation regression tests passed"
