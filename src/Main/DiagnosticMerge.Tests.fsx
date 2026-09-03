#r "../../artifacts/bin/Main/debug/FSharp.Data.dll"
#r "../../artifacts/bin/LSP/debug/LSP.dll"
#load "../TestHelpers.fsx"
#load "DiagnosticMerge.fs"

open System
open LSP.Types
open DiagnosticMerge
open TestHelpers

let dummyRange = { start = { line = 0; character = 0 }; ``end`` = { line = 0; character = 0 } }

let diagnostic code message =
    { range = dummyRange
      severity = None
      code = Some code
      codeDescription = None
      source = None
      message = message
      tags = None
      data = None
      relatedInformation = [] }

let parserDiagnostic = diagnostic "CW001_MISSING_CLOSE_BRACE" "Missing closing brace"
let semanticDiagnostic = diagnostic "CW102" "Unknown scripted trigger"
let previousCompleteResult = [ parserDiagnostic; semanticDiagnostic ]

// Agent writes are revalidated from disk and therefore have no editor document
// version. Opening the same file must not make that completed snapshot stale.
check (not (isValidatedDocumentVersionStale None (Some 7))) "Disk-backed diagnostics became stale merely because the file is open."
check (not (isValidatedDocumentVersionStale (Some 7) None)) "Closing a file made its completed diagnostics stale."
check (not (isValidatedDocumentVersionStale (Some 7) (Some 7))) "Matching editor versions must remain fresh."
check (isValidatedDocumentVersionStale (Some 7) (Some 8)) "A newer editor version must supersede the diagnostic snapshot."

let oldDynamicDiagnostic = diagnostic "CW274D" "Old expanded call-site diagnostic"
let newDynamicDiagnostic = diagnostic "CW274D" "Corrected expanded call-site diagnostic"
let batchResult =
    mergeDeferredDefinitionDiagnostics
        [ parserDiagnostic; semanticDiagnostic; oldDynamicDiagnostic ]
        [ newDynamicDiagnostic ]

check (batchResult |> List.contains parserDiagnostic) "Batched dynamic validation dropped parser diagnostics."
check (batchResult |> List.contains semanticDiagnostic) "Batched dynamic validation dropped unrelated semantic diagnostics."
check (not (batchResult |> List.contains oldDynamicDiagnostic)) "Batched dynamic validation retained a stale expansion diagnostic."
check (batchResult |> List.contains newDynamicDiagnostic) "Batched dynamic validation did not publish its corrected expansion diagnostic."

// Regression: a fix that leaves no dynamic errors must clear the stale
// expansion diagnostics an earlier batch published (inline-script callers).
let clearedBatchResult =
    mergeDeferredDefinitionDiagnostics [ parserDiagnostic; semanticDiagnostic; oldDynamicDiagnostic ] []

check (not (clearedBatchResult |> List.contains oldDynamicDiagnostic)) "Batched dynamic validation retained an expansion diagnostic after the fix."

let dummyLocation = { uri = Uri("file:///dummy"); range = dummyRange }

// An undefined variable reported at an expanded call site carries a related
// "Related source" entry; it belongs to the deferred dynamic domain and must
// be cleared by a later batch once the definition is fixed.
let undefinedVariableAtCallSite =
    { range = dummyRange
      severity = None
      code = Some "CW101"
      codeDescription = None
      source = None
      message = "@ship_part is not defined"
      tags = None
      data = None
      relatedInformation = [ { location = dummyLocation; message = "Related source" } ] }

check (isDynamicExpansionDiagnostic undefinedVariableAtCallSite) "Call-site undefined-variable diagnostics must belong to the deferred dynamic domain."

let mergedUndefinedVariable =
    mergeDeferredDefinitionDiagnostics [ undefinedVariableAtCallSite ] []

check (not (mergedUndefinedVariable |> List.contains undefinedVariableAtCallSite)) "Fixed call-site undefined-variable diagnostic was not cleared by the batch."

// A plain undefined-variable diagnostic (no expansion source) is owned by the
// immediate lint and must survive the deferred batch unchanged.
let plainUndefinedVariable =
    { range = dummyRange
      severity = None
      code = Some "CW101"
      codeDescription = None
      source = None
      message = "@ship_part is not defined"
      tags = None
      data = None
      relatedInformation = [] }

check (not (isDynamicExpansionDiagnostic plainUndefinedVariable)) "Plain undefined-variable diagnostics must stay with the immediate lint."

let mergedPlainUndefinedVariable =
    mergeDeferredDefinitionDiagnostics [ plainUndefinedVariable ] []

check (mergedPlainUndefinedVariable |> List.contains plainUndefinedVariable) "Deferred batch dropped a diagnostic owned by the immediate lint."

let localisationDiagnostic = diagnostic "CW100" "Missing localisation"
let localisationSubcodeDiagnostic = diagnostic "CW255_DETAIL" "Invalid localisation"

check (isLocalisationDiagnostic localisationDiagnostic) "CW100 must be classified as a localisation diagnostic."
check (isLocalisationDiagnostic localisationSubcodeDiagnostic) "Localisation diagnostic subcodes must inherit their base-code classification."
check (not (isLocalisationDiagnostic semanticDiagnostic)) "Non-localisation diagnostics must remain visible when localisation filtering is enabled."

// Regression: two stable groups of real dynamic errors must be validated in
// one pass. Requeuing the diagnostic-bearing group after each pass caused the
// groups to alternate forever and allocate terabytes of temporary data.
let plannedDynamicBatch =
    planDeferredDynamicRevalidationBatch
        (fun path -> path.ToLowerInvariant())
        10
        [ "C:/mod/group-a.txt" ]
        [ "C:/mod/group-b.txt"; "C:/MOD/GROUP-A.TXT" ]

equal [ "C:/mod/group-a.txt"; "C:/mod/group-b.txt" ] plannedDynamicBatch "Dynamic diagnostic carriers were not folded into one batch"

let boundedDynamicBatch =
    planDeferredDynamicRevalidationBatch
        id
        2
        [ "requested-b"; "requested-a" ]
        [ "diagnostic-c" ]

equal [ "requested-a"; "requested-b" ] boundedDynamicBatch "Requested files must be deterministic and retain bounded priority"

printfn "DiagnosticMerge tests passed"
