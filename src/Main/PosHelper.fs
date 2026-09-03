namespace Main

open CWTools.Utilities.Position

module Line =
    // Visual Studio uses line counts starting at 0, F# uses them starting at 1
    let fromZ (line: Line0) = int line + 1

    let toZ (line: int) : Line0 =
        LanguagePrimitives.Int32WithMeasure(line - 1)

module PosHelper =
    let fromZ (line: Line0) idx = mkPos (Line.fromZ line) idx
    let toZ (p: pos) = (Line.toZ p.Line, p.Column)

module LspConvert =
    open System
    open System.IO
    open LSP.Types

    let rangeToLsp (r: range) : Range =
        { start =
            { line = max 0 (int r.StartLine - 1)
              character = int r.StartColumn }
          ``end`` =
            { line = max 0 (int r.EndLine - 1)
              character = int r.EndColumn } }

    let lspPositionToPos (p: Position) : pos =
        mkPos (p.line + 1) p.character

    let filePathToUri (path: string) : Uri =
        try
            if path.StartsWith("file://", StringComparison.OrdinalIgnoreCase) then
                Uri(path)
            else
                let filePrefix = if path.StartsWith('/') then "file://" else "file:///"
                Uri(filePrefix + path.Replace('\\', '/'))
        with _ ->
            let filePrefix = if path.StartsWith('/') then "file://" else "file:///"
            Uri(filePrefix + path.Replace('\\', '/'))
