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

let oldDynamicDiagnostic = diagnostic "CW274D" "Old expanded call-site diagnostic"
let newDynamicDiagnostic = diagnostic "CW274D" "Corrected expanded call-site diagnostic"
let batchResult =
    mergeDeferredDefinitionDiagnostics
        [ parserDiagnostic; semanticDiagnostic; oldDynamicDiagnostic ]
        [ newDynamicDiagnostic ]

if not (batchResult |> List.contains parserDiagnostic) then
    failwith "Batched dynamic validation dropped parser diagnostics."

if not (batchResult |> List.contains semanticDiagnostic) then
    failwith "Batched dynamic validation dropped unrelated semantic diagnostics."

if batchResult |> List.contains oldDynamicDiagnostic then
    failwith "Batched dynamic validation retained a stale expansion diagnostic."

if not (batchResult |> List.contains newDynamicDiagnostic) then
    failwith "Batched dynamic validation did not publish its corrected expansion diagnostic."
