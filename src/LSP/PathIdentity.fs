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

/// True when `path` equals `root` or lives under it on a directory boundary.
/// Slash direction is unified first; case folding follows the platform, so a
/// root never matches a sibling that merely shares a prefix (".../stellaris2").
/// An empty/whitespace root matches nothing: the root must be a real directory.
let isUnderRootFor platform (path: string) (root: string) =
    if isNull path then nullArg (nameof path)
    if isNull root then nullArg (nameof root)
    let unify (value: string) = value.Replace('\\', '/').TrimEnd('/')
    let unifiedPath, unifiedRoot = unify path, unify root
    if String.IsNullOrWhiteSpace unifiedRoot then
        false
    else
        let comparison =
            match platform with
            | Windows -> StringComparison.OrdinalIgnoreCase
            | Unix -> StringComparison.Ordinal
        String.Equals(unifiedPath, unifiedRoot, comparison)
        || unifiedPath.StartsWith(unifiedRoot + "/", comparison)

let isUnderRoot path root = isUnderRootFor currentPlatform path root
