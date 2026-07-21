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

/// Deferred dynamic revalidation currently recomputes rule and localisation
/// diagnostics, but not parser diagnostics. Diagnostics without a code are
/// conservatively left to their original producer.
let isDeferredValidationDiagnostic (diagnostic: Diagnostic) =
    diagnostic.code.IsSome && not (isParserDiagnostic diagnostic)

let mergeDeferredValidationDiagnostics existing refreshed =
    replaceDomain isDeferredValidationDiagnostic existing refreshed

let mergeDeferredDefinitionDiagnostics existing refreshed =
    replaceDomain isDynamicExpansionDiagnostic existing refreshed

/// A model refresh makes diagnostics pending, not disproven. Keep the last
/// complete result visible until a validation pass for that file replaces it.
let preserveWhilePending (existing: Diagnostic list) = existing

/// A per-file lint of a dynamic definition sees the raw template, not every
/// parameterized call-site expansion. It owns direct/parser diagnostics and
/// must preserve the expansion diagnostics until deferred validation replaces
/// that complementary domain.
let mergeImmediateDefinitionDiagnostics existing refreshed =
    replaceDomain (isDynamicExpansionDiagnostic >> not) existing refreshed
