namespace Main

open System

module PdxFolding =

    type FoldingSpan =
        { startLine: int
          startCharacter: int
          endLine: int
          endCharacter: int option }

    /// Compute brace-delimited folding spans directly from the current buffer.
    /// Braces in quoted strings and # comments are ignored so incomplete editor
    /// text can still retain every structurally complete fold.
    let ranges (text: string) =
        let spans = ResizeArray<FoldingSpan>()
        let stack = ResizeArray<struct (int * int)>()
        let mutable line = 0
        let mutable character = 0
        let mutable lineStartOffset = 0
        let mutable inString = false
        let mutable escaped = false
        let mutable inComment = false

        let closerStartsLine offset =
            let mutable onlyWhitespace = true
            let mutable index = lineStartOffset
            while onlyWhitespace && index < offset do
                if not (Char.IsWhiteSpace text[index]) then
                    onlyWhitespace <- false
                index <- index + 1
            onlyWhitespace

        for offset = 0 to text.Length - 1 do
            let current = text[offset]
            if inComment then
                if current = '\n' then
                    inComment <- false
            elif inString then
                if escaped then
                    escaped <- false
                elif current = '\\' then
                    escaped <- true
                elif current = '"' then
                    inString <- false
            else
                match current with
                | '#' -> inComment <- true
                | '"' -> inString <- true
                | '{' -> stack.Add(struct (line, character))
                | '}' when stack.Count > 0 ->
                    let last = stack.Count - 1
                    let struct (startLine, startCharacter) = stack[last]
                    stack.RemoveAt(last)
                    if line > startLine then
                        let closesOwnLine = closerStartsLine offset
                        let endLine = if closesOwnLine then line - 1 else line
                        if endLine > startLine then
                            spans.Add(
                                { startLine = startLine
                                  startCharacter = startCharacter
                                  endLine = endLine
                                  endCharacter = if closesOwnLine then None else Some character }
                            )
                | _ -> ()

            if current = '\n' then
                line <- line + 1
                character <- 0
                lineStartOffset <- offset + 1
            else
                character <- character + 1

        spans
        |> Seq.sortBy (fun span -> span.startLine, span.startCharacter, span.endLine, span.endCharacter)
        |> Seq.toList
