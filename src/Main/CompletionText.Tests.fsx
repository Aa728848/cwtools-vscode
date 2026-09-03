#load "../TestHelpers.fsx"
#load "CompletionText.fs"

open Main.CompletionText
open TestHelpers

let assertEqual = assertEqualNamed
let assertNotEqual = assertNotEqualNamed

assertEqual "colon prefix" (Some "modifier:") (prefixFromTextBeforeCursor "d = modifier:")
assertEqual "namespaced prefix" (Some "modifier:beam") (prefixFromTextBeforeCursor "d = modifier:beam")
assertEqual "member prefix" (Some "beam") (prefixFromTextBeforeCursor "d = owner.beam")
assertEqual "empty value" None (prefixFromTextBeforeCursor "d = ")

assertEqual
    "multiline namespaced prefix"
    (Some "modifier:beam")
    (prefixAtPosition "first = value\nd = modifier:beam\nthird = value" 1 17)

assertEqual "colon insertion range" (4, 13, 13) (tokenRangeInLine "d = modifier:" 13)
assertEqual "colon replacement range" (4, 13, 17) (tokenRangeInLine "d = modifier:beam" 13)
assertEqual "token boundary" (4, 8, 8) (tokenRangeInLine "d = beam" 8)

let commonA = completionCacheKey "c:/mod/common/on_actions/a.txt" 17 4 2 false true
let commonB = completionCacheKey "c:/mod/common/decisions/b.txt" 17 4 2 false true
let editedA = completionCacheKey "c:/mod/common/on_actions/a.txt" 18 4 2 false true
let movedA = completionCacheKey "c:/mod/common/on_actions/a.txt" 17 5 2 false true
assertNotEqual "different common AST files" commonA commonB
assertNotEqual "edited document" commonA editedA
assertNotEqual "different cursor path" commonA movedA

printfn "CompletionText regression tests passed"
