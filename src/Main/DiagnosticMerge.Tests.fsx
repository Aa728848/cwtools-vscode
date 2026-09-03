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


// Agent writes are revalidated from disk and therefore have no editor document
// version. Opening the same file must not make that completed snapshot stale.
if isValidatedDocumentVersionStale None (Some 7) then
    failwith "Disk-backed diagnostics became stale merely because the file is open."

if isValidatedDocumentVersionStale (Some 7) None then
    failwith "Closing a file made its completed diagnostics stale."

if isValidatedDocumentVersionStale (Some 7) (Some 7) then
    failwith "Matching editor versions must remain fresh."

if not (isValidatedDocumentVersionStale (Some 7) (Some 8)) then
    failwith "A newer editor version must supersede the diagnostic snapshot."

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

let localisationDiagnostic = diagnostic "CW100" "Missing localisation"
let localisationSubcodeDiagnostic = diagnostic "CW255_DETAIL" "Invalid localisation"

if not (isLocalisationDiagnostic localisationDiagnostic) then
    failwith "CW100 must be classified as a localisation diagnostic."

if not (isLocalisationDiagnostic localisationSubcodeDiagnostic) then
    failwith "Localisation diagnostic subcodes must inherit their base-code classification."

if isLocalisationDiagnostic semanticDiagnostic then
    failwith "Non-localisation diagnostics must remain visible when localisation filtering is enabled."

// Regression: two stable groups of real dynamic errors must be validated in
// one pass. Requeuing the diagnostic-bearing group after each pass caused the
// groups to alternate forever and allocate terabytes of temporary data.
let plannedDynamicBatch =
    planDeferredDynamicRevalidationBatch
        (fun path -> path.ToLowerInvariant())
        10
        [ "C:/mod/group-a.txt" ]
        [ "C:/mod/group-b.txt"; "C:/MOD/GROUP-A.TXT" ]

if plannedDynamicBatch <> [ "C:/mod/group-a.txt"; "C:/mod/group-b.txt" ] then
    failwithf "Dynamic diagnostic carriers were not folded into one batch: %A" plannedDynamicBatch

let boundedDynamicBatch =
    planDeferredDynamicRevalidationBatch
        id
        2
        [ "requested-b"; "requested-a" ]
        [ "diagnostic-c" ]

if boundedDynamicBatch <> [ "requested-a"; "requested-b" ] then
    failwithf "Requested files must be deterministic and retain bounded priority: %A" boundedDynamicBatch
