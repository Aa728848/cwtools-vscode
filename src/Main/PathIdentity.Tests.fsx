#load "../TestHelpers.fsx"
#load "PathIdentity.fs"

open System
open PathIdentity
open TestHelpers

// Windows alone folds slash direction and case; it does not perform cleanup.
equal "C:/MOD/FILE.TXT" (normalizeFor Windows @"c:\Mod/file.txt") "Windows identity"
equal true (equalsFor Windows @"C:\A\b" "c:/a/B") "Windows equality"
equal "C:/A/../B" (normalizeFor Windows @"c:\a\..\b") "No canonicalization"
equal "" (normalizeFor Windows "") "Windows empty path"
equal true (equalsFor Windows "" "") "Windows empty equality"
throws<ArgumentNullException> (fun () -> normalizeFor Windows null |> ignore) "Windows null rejected"
throws<ArgumentNullException> (fun () -> equalsFor Windows null "x" |> ignore) "Windows null left rejected"
throws<ArgumentNullException> (fun () -> equalsFor Windows "x" null |> ignore) "Windows null right rejected"

// Unix preserves both case and backslash exactly.
equal "a\B/c" (normalizeFor Unix "a\B/c") "Unix identity"
equal false (equalsFor Unix "a\b" "a/b") "Unix backslash"
equal false (equalsFor Unix "A/b" "a/b") "Unix case"
throws<ArgumentNullException> (fun () -> normalizeFor Unix null |> ignore) "Unix null rejected"
throws<ArgumentNullException> (fun () -> equalsFor Unix null "x" |> ignore) "Unix null left rejected"
throws<ArgumentNullException> (fun () -> equalsFor Unix "x" null |> ignore) "Unix null right rejected"

// Current-platform wrappers have the same explicit invalid-input contract.
throws<ArgumentNullException> (fun () -> normalize null |> ignore) "Current null rejected"
throws<ArgumentNullException> (fun () -> equals null "x" |> ignore) "Current null left rejected"
throws<ArgumentNullException> (fun () -> equals "x" null |> ignore) "Current null right rejected"
equal "" (normalize "") "Current empty path"
equal true (equals "" "") "Current empty equality"

printfn "PathIdentity tests passed"
