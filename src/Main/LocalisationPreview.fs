module Main.LocalisationPreview

open System
open System.Text.RegularExpressions

let private compiled = RegexOptions.Compiled
let private maxReferenceDepth = 8
let private maxExpandedLength = 4096

let private localisationReferencePattern =
    Regex(@"\$([^$\r\n]+)\$", compiled)

let private localisationReferenceKeyPattern =
    Regex(@"^[A-Za-z0-9_@.:'/-]+$", compiled)

let private localisationConceptPattern =
    Regex(@"\[\s*'([^'\]\r\n]+)'(?:\s*,?\s*'?([^'\]\r\n]*)'?)?\s*\]", compiled)

let private localisationIconPattern =
    Regex(
        @"\u00C2?\u00A3([A-Za-z0-9_.:-]+)(?:\|([^\u00A3\u00C2\s\[\]]+))?(?:\u00C2?\u00A3)?",
        compiled)

let private localisationStyleCodePattern =
    Regex(@"(?:\u00C2?\u00A7|\u6402)[A-Za-z0-9!%-]", compiled)

let private localisationWhitespaceMarkerPattern =
    Regex(@"\$(?:t|tt|TABBED_NEW_LINE|NEW_LINE)\$", RegexOptions.IgnoreCase ||| compiled)

let private localisationCollapsedWhitespacePattern =
    Regex(@"\s+", compiled)

// Name-list sequence/roman-numeral spec, e.g. (100?:(| C CC ...); 10?:(...); 1?:(...)).
let private localisationSequenceFormatPattern =
    Regex(@"\(\s*\d+\?:(?:[^()]|\([^()]*\))*\)", compiled)

let private stripLocQuotes (value: string) =
    let trimmed = value.Trim()
    if trimmed.Length >= 2 && trimmed.StartsWith("\"") && trimmed.EndsWith("\"") then
        trimmed.Substring(1, trimmed.Length - 2)
    else
        trimmed

let private bounded (value: string) =
    if value.Length <= maxExpandedLength then value
    else value.Substring(0, maxExpandedLength)

let private tryReferenceKey (payload: string) =
    let separator = payload.IndexOf('|')
    let key =
        if separator >= 0 then payload.Substring(0, separator)
        else payload
    let key = key.Trim()
    if localisationReferenceKeyPattern.IsMatch(key) then Some key else None

let formatHintLabel
    (tryFindLocalisation: string -> string option)
    (tryFindVariable: string -> string option)
    (description: string)
    =
    let rec resolveText depth visited (text: string) =
        let text = bounded text
        if depth >= maxReferenceDepth || String.IsNullOrEmpty text then
            text
        else
            let resolveKey original key =
                if Set.contains key visited then
                    original
                else
                    let replacement =
                        match tryFindLocalisation key with
                        | Some value -> Some value
                        | None -> tryFindVariable key
                    match replacement with
                    | Some value ->
                        resolveText (depth + 1) (Set.add key visited) (stripLocQuotes value)
                    | None -> original

            let withReferences =
                localisationReferencePattern.Replace(
                    text,
                    MatchEvaluator(fun m ->
                        if localisationWhitespaceMarkerPattern.IsMatch(m.Value) then
                            " "
                        else
                            match tryReferenceKey m.Groups.[1].Value with
                            | Some key -> resolveKey m.Value key
                            | None -> m.Value))
                |> bounded

            localisationConceptPattern.Replace(
                withReferences,
                MatchEvaluator(fun m ->
                    let explicitLabel = m.Groups.[2]
                    if explicitLabel.Success && not (String.IsNullOrWhiteSpace explicitLabel.Value) then
                        resolveText (depth + 1) visited explicitLabel.Value
                    else
                        resolveKey m.Value m.Groups.[1].Value))
            |> bounded

    let clean =
        description
            .Replace("\r\n", " ")
            .Replace("\n", " ")
            .Replace("\\n", " ")
            .Trim()
        |> stripLocQuotes
        |> resolveText 0 Set.empty
        |> fun value -> localisationSequenceFormatPattern.Replace(value, "")
        // Inlay hints cannot render game colours or sprite images. Keep icon calls
        // such as £energy£ visible as text, while removing colour control codes.
        |> fun value ->
            localisationIconPattern.Replace(
                value,
                MatchEvaluator(fun m ->
                    let modifier = m.Groups.[2]
                    if modifier.Success then
                        "£" + m.Groups.[1].Value + "|" + modifier.Value + "£"
                    else
                        "£" + m.Groups.[1].Value + "£"))
        |> fun value -> localisationWhitespaceMarkerPattern.Replace(value, " ")
        |> fun value -> localisationStyleCodePattern.Replace(value, "")
        |> fun value -> localisationCollapsedWhitespacePattern.Replace(value, " ").Trim()

    if String.IsNullOrWhiteSpace clean then
        None
    else
        let truncated =
            if clean.Length > 50 then clean.Substring(0, 50) + "..."
            else clean
        Some truncated
