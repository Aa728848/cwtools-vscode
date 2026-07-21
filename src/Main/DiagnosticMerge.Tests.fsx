module LSP =
    module Types =
        type DiagnosticRelatedInformation =
            { message: string }

        type Diagnostic =
            { code: string option
              message: string
              relatedInformation: DiagnosticRelatedInformation list }

#load "DiagnosticMerge.fs"

open LSP.Types
open DiagnosticMerge

let diagnostic code message =
    { Diagnostic.code = Some code
      message = message
      relatedInformation = [] }

let parserDiagnostic = diagnostic "CW001_MISSING_CLOSE_BRACE" "Missing closing brace"
let semanticDiagnostic = diagnostic "CW102" "Unknown scripted trigger"
let previousCompleteResult = [ parserDiagnostic; semanticDiagnostic ]

let pendingResult = preserveWhilePending previousCompleteResult

if pendingResult <> previousCompleteResult then
    failwith "Pending global revalidation must preserve parser and semantic diagnostics."

if not (pendingResult |> List.exists (fun item -> item.code = Some "CW102")) then
    failwith "Pending global revalidation dropped the last complete semantic diagnostic."
