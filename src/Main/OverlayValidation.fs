namespace Main

open System
open System.Collections.Generic
open System.IO

module OverlayValidation =
    let MaxFiles = 64
    let MaxFileChars = 2_000_000
    let MaxTotalChars = 8_000_000

    let private pathComparison =
        if OperatingSystem.IsWindows() then StringComparison.OrdinalIgnoreCase
        else StringComparison.Ordinal

    /// Normalize Win32 device paths so local and UNC spellings returned by
    /// ResolveLinkTarget can be compared with ordinary file-URI paths.
    let normalizeResolvedPath (path: string) =
        let full = Path.GetFullPath(path)
        if OperatingSystem.IsWindows() && full.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) then
            @"\\" + full.Substring(8)
        elif OperatingSystem.IsWindows() && full.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) then
            full.Substring(4)
        else
            full

    let private tryFileSystemInfo (path: string) =
        try
            let attributes = File.GetAttributes(path)
            if (attributes &&& FileAttributes.Directory) <> enum<FileAttributes> 0 then
                Some(DirectoryInfo(path) :> FileSystemInfo)
            else
                Some(FileInfo(path) :> FileSystemInfo)
        with
        | :? FileNotFoundException
        | :? DirectoryNotFoundException -> None

    let private resolveExisting (info: FileSystemInfo) =
        let target = info.ResolveLinkTarget(true)
        if isNull target then info.FullName else target.FullName
        |> normalizeResolvedPath

    /// Resolve the final existing target, or the nearest existing parent for a
    /// path that does not exist yet. This closes symlink/junction escapes while
    /// still allowing overlays for new files. Resolution failures are rejected.
    let tryResolveFinalPath (path: string) =
        try
            let full = normalizeResolvedPath path
            let rec findExisting current =
                match tryFileSystemInfo current with
                | Some info ->
                    let resolvedParent = resolveExisting info
                    let suffix = Path.GetRelativePath(current, full)
                    if suffix = "." then Some resolvedParent
                    elif Path.IsPathRooted suffix || suffix = ".." || suffix.StartsWith(".." + string Path.DirectorySeparatorChar, pathComparison) then None
                    else Some(normalizeResolvedPath (Path.Combine(resolvedParent, suffix)))
                | None ->
                    let parent = Path.GetDirectoryName current
                    if String.IsNullOrEmpty parent || String.Equals(parent, current, pathComparison) then None
                    else findExisting parent
            findExisting full
        with
        | :? IOException
        | :? UnauthorizedAccessException
        | :? ArgumentException
        | :? NotSupportedException -> None

    let isPathWithinResolvedRoot (root: string) (candidate: string) =
        match tryResolveFinalPath root, tryResolveFinalPath candidate with
        | Some resolvedRoot, Some resolvedCandidate ->
            let relative = Path.GetRelativePath(resolvedRoot, resolvedCandidate)
            relative = "."
            || (not (Path.IsPathRooted relative)
                && relative <> ".."
                && not (relative.StartsWith(".." + string Path.DirectorySeparatorChar, pathComparison)))
        | _ -> false

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
