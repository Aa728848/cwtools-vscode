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

// Regression: a fix that leaves no dynamic errors must clear the stale
// expansion diagnostics an earlier batch published (inline-script callers).
let clearedBatchResult =
    mergeDeferredDefinitionDiagnostics [ parserDiagnostic; semanticDiagnostic; oldDynamicDiagnostic ] []

if clearedBatchResult |> List.contains oldDynamicDiagnostic then
    failwith "Batched dynamic validation retained an expansion diagnostic after the fix."

// An undefined variable reported at an expanded call site carries a related
// "Related source" entry; it belongs to the deferred dynamic domain and must
// be cleared by a later batch once the definition is fixed.
let undefinedVariableAtCallSite =
    { Diagnostic.code = Some "CW101"
      message = "@ship_part is not defined"
      relatedInformation = [ { message = "Related source" } ] }

if not (isDynamicExpansionDiagnostic undefinedVariableAtCallSite) then
    failwith "Call-site undefined-variable diagnostics must belong to the deferred dynamic domain."

let mergedUndefinedVariable =
    mergeDeferredDefinitionDiagnostics [ undefinedVariableAtCallSite ] []

if mergedUndefinedVariable |> List.contains undefinedVariableAtCallSite then
    failwith "Fixed call-site undefined-variable diagnostic was not cleared by the batch."

// A plain undefined-variable diagnostic (no expansion source) is owned by the
// immediate lint and must survive the deferred batch unchanged.
let plainUndefinedVariable =
    { Diagnostic.code = Some "CW101"
      message = "@ship_part is not defined"
      relatedInformation = [] }

if isDynamicExpansionDiagnostic plainUndefinedVariable then
    failwith "Plain undefined-variable diagnostics must stay with the immediate lint."

let mergedPlainUndefinedVariable =
    mergeDeferredDefinitionDiagnostics [ plainUndefinedVariable ] []

if not (mergedPlainUndefinedVariable |> List.contains plainUndefinedVariable) then
    failwith "Deferred batch dropped a diagnostic owned by the immediate lint."
