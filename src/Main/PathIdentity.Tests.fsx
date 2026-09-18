#load "../TestHelpers.fsx"
#load "../LSP/PathIdentity.fs"

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

// isUnderRootFor: directory-boundary prefix with platform case semantics.
equal true (isUnderRootFor Windows @"D:\Games\Stellaris\common\a.txt" @"D:\Games\Stellaris") "Windows child"
equal true (isUnderRootFor Windows @"d:\games\stellaris\common\a.txt" @"D:\Games\Stellaris") "Windows case folding"
equal true (isUnderRootFor Windows @"D:\Games\Stellaris\common\a.txt" @"D:\Games\Stellaris\") "Windows trailing slash root"
equal true (isUnderRootFor Windows "D:/Games/Stellaris/common/a.txt" @"D:\Games\Stellaris") "Windows slash unification"
equal true (isUnderRootFor Windows @"D:\Games\Stellaris" @"D:\Games\Stellaris") "Windows root equality"
equal false (isUnderRootFor Windows @"D:\Games\Stellaris2\common\a.txt" @"D:\Games\Stellaris") "Windows sibling prefix rejected"
equal false (isUnderRootFor Windows @"C:\Elsewhere\a.txt" @"D:\Games\Stellaris") "Windows unrelated rejected"
equal false (isUnderRootFor Windows @"D:\Games\Stellaris" @"D:\Games\Stellaris\common") "Windows parent rejected"
equal true (isUnderRootFor Unix "/games/stellaris/common/a.txt" "/games/stellaris") "Unix child"
equal false (isUnderRootFor Unix "/Games/Stellaris/common/a.txt" "/games/stellaris") "Unix case sensitive"
equal false (isUnderRootFor Unix "/games/stellaris2/common/a.txt" "/games/stellaris") "Unix sibling prefix rejected"
equal false (isUnderRootFor Windows @"D:\Games\Stellaris\a.txt" "") "Empty root rejected"
equal false (isUnderRootFor Unix "/a/b" "/") "Filesystem root rejected"
throws<ArgumentNullException> (fun () -> isUnderRootFor Windows null "x" |> ignore) "Null path rejected"
throws<ArgumentNullException> (fun () -> isUnderRootFor Windows "x" null |> ignore) "Null root rejected"

printfn "PathIdentity tests passed"
