#load "OverlayValidation.fs"

open Main.OverlayValidation

let assertEqual name expected actual =
    if expected <> actual then failwithf "%s: expected %A, got %A" name expected actual

assertEqual "accept" [| Accept; Accept |] (admit [| "a.txt", 1; "b.txt", 2 |])
assertEqual "duplicate" [| Accept; Duplicate |] (admit [| "a.txt", 1; "a.txt", 1 |])
assertEqual "single oversized" [| Oversized |] (admit [| "a.txt", MaxFileChars + 1 |])
assertEqual "total oversized" [| Accept; Accept; Accept; Accept; Oversized |] (admit [| "a.txt", MaxFileChars; "b.txt", MaxFileChars; "c.txt", MaxFileChars; "d.txt", MaxFileChars; "e.txt", 1 |])
let many = Array.init (MaxFiles + 1) (fun index -> string index, 0)
assertEqual "truncated" Truncated (admit many).[MaxFiles]

printfn "Overlay validation regression tests passed"
