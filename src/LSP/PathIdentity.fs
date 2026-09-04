module PathIdentity

open System

/// Platform semantics are explicit so callers and tests do not depend on the host OS.
type Platform =
    | Windows
    | Unix

let currentPlatform =
    if OperatingSystem.IsWindows() then Windows else Unix

let normalizeFor platform (path: string) =
    if isNull path then nullArg (nameof path)
    match platform with
    | Windows -> path.Replace('\\', '/').ToUpperInvariant()
    | Unix -> path

let normalize path = normalizeFor currentPlatform path

let equalsFor platform left right =
    normalizeFor platform left = normalizeFor platform right

let equals left right = equalsFor currentPlatform left right

/// Normalizes a relative or logical PDX path for case-insensitive graph and lookup keys.
/// Normalizes backslashes to forward slashes, trims whitespace, drops leading slash, and folds to lowercase.
let normalizeLogicalPath (path: string) =
    if isNull path then ""
    else path.Replace('\\', '/').Trim().TrimStart('/').ToLowerInvariant()
