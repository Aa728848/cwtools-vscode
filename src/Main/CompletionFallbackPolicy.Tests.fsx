#load "../TestHelpers.fsx"
#load "CompletionFallbackPolicy.fs"

open Main.CompletionFallbackPolicy
open TestHelpers

let assertEqual = assertEqualNamed

assertEqual
    "validation alone does not trigger immediate fallback"
    false
    (shouldUseImmediateFallback false false)

assertEqual
    "validation alone cannot produce an empty fallback"
    false
    (canReturnEmptyFallback false)

assertEqual
    "an active writer still triggers the bounded fallback"
    true
    (shouldUseImmediateFallback true false)

assertEqual
    "an active writer may return an empty fallback"
    true
    (canReturnEmptyFallback true)

assertEqual
    "the heavy interactive window still prefers a cached fallback"
    true
    (shouldUseImmediateFallback false true)

printfn "CompletionFallbackPolicy regression tests passed"
