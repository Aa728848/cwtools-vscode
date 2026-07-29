module Main.SemanticDirectoryCatalog

open System
open System.Collections.Generic
open System.Text.RegularExpressions

type SemanticDirectoryPath =
    { path: string
      entityTypes: string list }

module Catalog =
    let private schemePattern = Regex("^[A-Za-z][A-Za-z0-9+.-]*:", RegexOptions.CultureInvariant)
    let private dynamicPathPattern = Regex("[*?$<>{}\\[\\]]", RegexOptions.CultureInvariant)

    let tryNormalizePath (value: string) : string option =
        if String.IsNullOrWhiteSpace value then
            None
        else
            let trimmed = value.Trim()
            if trimmed.StartsWith("/", StringComparison.Ordinal)
               || trimmed.StartsWith("\\", StringComparison.Ordinal)
               || schemePattern.IsMatch trimmed
               || dynamicPathPattern.IsMatch trimmed
               || trimmed.IndexOf('\u0000') >= 0 then
                None
            else
                let slashPath = trimmed.Replace('\\', '/').TrimEnd('/')
                let withoutGameRoot =
                    if slashPath.Equals("game", StringComparison.OrdinalIgnoreCase) then
                        ""
                    elif slashPath.StartsWith("game/", StringComparison.OrdinalIgnoreCase) then
                        slashPath.Substring(5)
                    else
                        slashPath
                let segments = withoutGameRoot.Split('/')
                if segments.Length = 0
                   || segments
                      |> Array.exists (fun segment ->
                          String.IsNullOrWhiteSpace segment
                          || segment = "."
                          || segment = ".."
                          || schemePattern.IsMatch segment
                          || segment.IndexOf('\u0000') >= 0) then
                    None
                else
                    Some(String.Join("/", segments))

    let build (definitions: seq<string * seq<string>>) : SemanticDirectoryPath list =
        let paths = SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal)
        for entityType, candidates in definitions do
            let normalizedEntityType =
                if String.IsNullOrWhiteSpace entityType then "" else entityType.Trim().ToLowerInvariant()
            if normalizedEntityType <> "" then
                for candidate in candidates do
                    match tryNormalizePath candidate with
                    | Some path ->
                        let entityTypes =
                            match paths.TryGetValue path with
                            | true, existing -> existing
                            | false, _ ->
                                let created = SortedSet<string>(StringComparer.Ordinal)
                                paths.Add(path, created)
                                created
                        entityTypes.Add normalizedEntityType |> ignore
                    | None -> ()
        paths
        |> Seq.map (fun pair ->
            { path = pair.Key
              entityTypes = pair.Value |> Seq.toList })
        |> Seq.toList
