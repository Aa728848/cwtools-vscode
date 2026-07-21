#load "CompletionText.fs"

open Main.CompletionText

let private assertEqual name expected actual =
    if expected <> actual then
        failwith $"{name}: expected {expected}, got {actual}"

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

printfn "CompletionText regression tests passed"
