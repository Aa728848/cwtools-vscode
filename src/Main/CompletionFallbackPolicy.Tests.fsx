#load "CompletionFallbackPolicy.fs"

open Main.CompletionFallbackPolicy

let private assertEqual name expected actual =
    if expected <> actual then
        failwith $"{name}: expected {expected}, got {actual}"

assertEqual
    "validation alone does not trigger immediate fallback"
    false
    (shouldUseImmediateFallback false true false)

assertEqual
    "validation alone cannot produce an empty fallback"
    false
    (canReturnEmptyFallback false true)

assertEqual
    "an active writer still triggers the bounded fallback"
    true
    (shouldUseImmediateFallback true true false)

assertEqual
    "an active writer may return an empty fallback"
    true
    (canReturnEmptyFallback true true)

assertEqual
    "the heavy interactive window still prefers a cached fallback"
    true
    (shouldUseImmediateFallback false true true)

printfn "CompletionFallbackPolicy regression tests passed"
