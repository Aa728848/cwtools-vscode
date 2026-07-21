module Main.CompletionText

open System

let private prefixBoundaries =
    [| ' '
       '\t'
       '='
       '<'
       '>'
       '{'
       '}'
       ','
       '|'
       '('
       ')'
       '['
       ']'
       '"'
       '\''
       '\n'
       '\r' |]

/// Extract the token VS Code should use to filter completion candidates.
/// A colon is part of namespaced values such as `modifier:foo`.
let prefixFromTextBeforeCursor (textBeforeCursor: string) =
    let boundary = textBeforeCursor.LastIndexOfAny(prefixBoundaries)

    let token =
        if boundary >= 0 then
            textBeforeCursor.Substring(boundary + 1)
        else
            textBeforeCursor

    let dotIndex = token.LastIndexOf('.')

    let prefix =
        if dotIndex >= 0 then token.Substring(dotIndex + 1) else token

    if String.IsNullOrWhiteSpace prefix then None else Some prefix

let lineBeforeCursor (text: string) (line: int) (character: int) =
    if line < 0 then
        ""
    else
        let mutable index = 0
        let mutable currentLine = 0

        while currentLine < line && index < text.Length do
            if text.[index] = '\n' then
                currentLine <- currentLine + 1

            index <- index + 1

        if index >= text.Length then
            ""
        else
            let mutable lineEnd = index

            while lineEnd < text.Length && text.[lineEnd] <> '\n' && text.[lineEnd] <> '\r' do
                lineEnd <- lineEnd + 1

            let safeCharacter = Math.Max(0, Math.Min(character, lineEnd - index))
            text.Substring(index, safeCharacter)

let prefixAtPosition (text: string) (line: int) (character: int) =
    lineBeforeCursor text line character |> prefixFromTextBeforeCursor

let private isTokenCharacter character =
    not (
        Char.IsWhiteSpace character
        || character = '.'
        || character = '|'
        || character = '"'
        || character = '='
        || character = '{'
        || character = '}'
        || character = ','
    )

/// Return the start, cursor, and end columns of the completion token.
let tokenRangeInLine (lineText: string) (character: int) =
    let cursor = Math.Max(0, Math.Min(character, lineText.Length))
    let mutable tokenStart = cursor

    while tokenStart > 0 && isTokenCharacter lineText.[tokenStart - 1] do
        tokenStart <- tokenStart - 1

    let mutable tokenEnd = cursor

    while tokenEnd < lineText.Length && isTokenCharacter lineText.[tokenEnd] do
        tokenEnd <- tokenEnd + 1

    tokenStart, cursor, tokenEnd
