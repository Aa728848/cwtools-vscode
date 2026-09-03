module DiagnosticMerge

open System
open LSP.Types

/// Replace only the diagnostics owned by a partial validation pass.
/// LSP publishDiagnostics replaces the complete list for a URI, so callers must
/// merge partial results with diagnostics produced by other passes first.
let replaceDomain
    (belongsToDomain: Diagnostic -> bool)
    (existing: Diagnostic list)
    (refreshed: Diagnostic list)
    =
    let preserved = existing |> List.filter (belongsToDomain >> not)
    let replacements = refreshed |> List.filter belongsToDomain
    preserved @ replacements

/// Parser, brace-scan, and structural-recovery diagnostics all use CW001 or a
/// CW001_* sub-code and are produced by the immediate per-file lint pass.
let isParserDiagnostic (diagnostic: Diagnostic) =
    diagnostic.code
    |> Option.exists (fun code -> code.StartsWith("CW001", StringComparison.OrdinalIgnoreCase))

let isDynamicExpansionDiagnostic (diagnostic: Diagnostic) =
    let hasDynamicCode =
        diagnostic.code
        |> Option.exists (fun code -> code.StartsWith("CW274", StringComparison.OrdinalIgnoreCase))

    hasDynamicCode
    || diagnostic.message.Contains("results in an error", StringComparison.OrdinalIgnoreCase)
    || (diagnostic.relatedInformation
        |> List.exists (fun related -> related.message = "Related source"))

/// CW codes whose diagnostics are produced by localisation validation. Keep
/// this list synchronized with LOCALISATION_CODES in client diagnosticI18n.ts.
let private localisationDiagnosticCodes =
    set
        [ "CW100"; "CW225"; "CW226"; "CW234"; "CW254"; "CW255"
          "CW256"; "CW257"; "CW258"; "CW259"; "CW260"; "CW266"
          "CW268"; "CW275" ]

let isLocalisationDiagnostic (diagnostic: Diagnostic) =
    diagnostic.code
    |> Option.exists (fun code ->
        let baseCode = code.Split('_').[0].ToUpperInvariant()
        localisationDiagnosticCodes.Contains baseCode)

/// Deferred dynamic revalidation currently recomputes rule and localisation
/// diagnostics, but not parser diagnostics. Diagnostics without a code are
/// conservatively left to their original producer.
let isDeferredValidationDiagnostic (diagnostic: Diagnostic) =
    diagnostic.code.IsSome && not (isParserDiagnostic diagnostic)

let mergeDeferredValidationDiagnostics existing refreshed =
    replaceDomain isDeferredValidationDiagnostic existing refreshed

let mergeDeferredDefinitionDiagnostics existing refreshed =
    replaceDomain isDynamicExpansionDiagnostic existing refreshed

/// A deferred dynamic pass must include the files that currently carry
/// expansion diagnostics in the same bounded batch as the newly requested
/// files. Scheduling those diagnostic files after every pass lets two stable
/// groups of real errors continually requeue each other.
let planDeferredDynamicRevalidationBatch
    (normalisePath: string -> string)
    (maxFiles: int)
    (requestedFiles: string list)
    (diagnosticFiles: string list)
    =
    let capacity = max 0 maxFiles
    let distinctSorted files =
        files
        |> List.distinctBy normalisePath
        |> List.sortBy normalisePath

    let requested =
        requestedFiles
        |> distinctSorted
        |> List.truncate capacity
    let requestedKeys = requested |> List.map normalisePath |> Set.ofList
    let remainingCapacity = capacity - requested.Length
    let diagnosticCleanup =
        diagnosticFiles
        |> distinctSorted
        |> List.filter (normalisePath >> requestedKeys.Contains >> not)
        |> List.truncate remainingCapacity

    requested @ diagnosticCleanup


/// Document versions only supersede a diagnostic snapshot when both sides are
/// editor-backed. Disk revalidation and closed files intentionally have no
/// document version and must not be treated as stale for that reason alone.
let isValidatedDocumentVersionStale validatedVersion currentVersion =
    match validatedVersion, currentVersion with
    | Some validated, Some current -> validated <> current
    | _ -> false

/// A per-file lint of a dynamic definition sees the raw template, not every
/// parameterized call-site expansion. It owns direct/parser diagnostics and
/// must preserve the expansion diagnostics until deferred validation replaces
/// that complementary domain.
let mergeImmediateDefinitionDiagnostics existing refreshed =
    replaceDomain (isDynamicExpansionDiagnostic >> not) existing refreshed
