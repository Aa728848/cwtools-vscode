namespace Main

open System
open System.Collections.Generic

module OverlayValidation =
    let MaxFiles = 64
    let MaxFileChars = 2_000_000
    let MaxTotalChars = 8_000_000

    type PayloadDecision =
        | Accept
        | Duplicate
        | Oversized
        | Truncated

    /// Deterministic bounded admission used by the LSP command before parsing or
    /// touching the active game catalog. Paths are compared with platform rules.
    let admit (pathsAndLengths: (string * int) array) =
        let comparer =
            if OperatingSystem.IsWindows() then StringComparer.OrdinalIgnoreCase
            else StringComparer.Ordinal
        let seen = HashSet<string>(comparer)
        let mutable total = 0
        pathsAndLengths
        |> Array.mapi (fun index (path, length) ->
            if index >= MaxFiles then Truncated
            else
                total <- total + max 0 length
                if length > MaxFileChars || total > MaxTotalChars then Oversized
                elif not (seen.Add path) then Duplicate
                else Accept)
