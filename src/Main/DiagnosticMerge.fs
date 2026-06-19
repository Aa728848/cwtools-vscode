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

/// Deferred dynamic revalidation currently recomputes rule and localisation
/// diagnostics, but not parser diagnostics. Diagnostics without a code are
/// conservatively left to their original producer.
let isDeferredValidationDiagnostic (diagnostic: Diagnostic) =
    diagnostic.code.IsSome && not (isParserDiagnostic diagnostic)

let mergeDeferredValidationDiagnostics existing refreshed =
    replaceDomain isDeferredValidationDiagnostic existing refreshed
