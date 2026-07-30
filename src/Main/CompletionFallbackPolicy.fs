module Main.CompletionFallbackPolicy

/// Validation runs under the shared game-state read lock, so its activity alone
/// must not suppress completion. Only a writer or a bounded heavy-path window
/// requires the immediate fallback.
let shouldUseImmediateFallback writerBusy _validationInProgress heavyPathWindow =
    writerBusy || heavyPathWindow

/// Returning an empty list is safe only while the game-state writer is active.
/// A long-running validation must allow the normal completion request through
/// when no stale result is available.
let canReturnEmptyFallback writerBusy _validationInProgress =
    writerBusy
