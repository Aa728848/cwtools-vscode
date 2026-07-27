module Main.SemanticDelta

open System

/// Validation/completion-visible contribution of a file change. Path routing
/// identifies the candidate domains; exact type keys and semantic equality are
/// supplied by the staged CWTools type index before a global refresh is queued.
type SemanticDelta =
    { domains: Set<string>
      changedTypeKeys: Set<string>
      localisationKeys: Set<string>
      dynamicDefinitions: Set<string>
      callSites: Set<string>
      completionVisible: bool
      validationVisible: bool }

/// Refined decision produced from a semantic delta. The decision keeps
/// path-based fast-paths conservative while avoiding full RefreshCaches when
/// the staged change is proven local to the type index or scripted services.
type SemanticDecision =
    | SemanticNoOp
    | TypeIndexOnly
    | ScriptedServices
    | FullRefresh of reason: string

let typeDefiningSegments =
    [| "/common/"; "\\common\\"
       "/events/"; "\\events\\"
       "/interface/"; "\\interface\\"
       "/gfx/"; "\\gfx\\"
       "/map/"; "\\map\\"
       "/prescripted_countries/"; "\\prescripted_countries\\" |]

/// Conservative path-based fast-path: true when the file lives in a directory
/// that is *capable* of contributing type/enum/scope definitions. The actual
/// type-defining decision is made by inspecting the staged semantic delta.
let isTypeDefiningPath (path: string) =
    let lp = path.ToLowerInvariant()
    typeDefiningSegments |> Array.exists (fun seg -> lp.Contains(seg))

let dynamicDefinitionPathMarkers =
    [| "common/inline_scripts/"
       "common/scripted_effects/"
       "common/scripted_triggers/"
       "common/script_values/"
       "common/scripted_variables/"
       "common/scripted_loc/"
       "common/static_modifiers/" |]

let scriptedDefinitionPathMarkers =
    [| "common/scripted_effects/"
       "common/scripted_triggers/"
       "common/scripted_values/" |]

let isDynamicDefinitionPath (path: string) =
    let normalised = path.Replace('\\', '/').ToLowerInvariant()
    dynamicDefinitionPathMarkers |> Array.exists normalised.Contains

let isScriptedDefinitionPath (path: string) =
    let normalised = path.Replace('\\', '/').ToLowerInvariant()
    scriptedDefinitionPathMarkers |> Array.exists normalised.Contains

let isEventDefinitionPath (path: string) =
    let normalised = path.Replace('\\', '/').ToLowerInvariant()
    normalised.Contains("/events/")

let isCompletionHeavyEditPath (path: string) =
    isDynamicDefinitionPath path || isTypeDefiningPath path

let inlineScriptPathMarker = "common/inline_scripts/"

let tryInlineScriptNameFromPath (path: string) =
    let normalised = path.Replace('\\', '/').ToLowerInvariant()
    let markerIdx = normalised.IndexOf(inlineScriptPathMarker, StringComparison.Ordinal)
    if markerIdx >= 0 then
        Some(normalised.Substring(markerIdx + inlineScriptPathMarker.Length))
    else
        None

let isInlineScriptDefinitionPath (path: string) =
    tryInlineScriptNameFromPath path |> Option.isSome

let isTypeIndexOnlyRefreshPath (path: string) =
    isTypeDefiningPath path
    && not (isDynamicDefinitionPath path)
    && not (isInlineScriptDefinitionPath path)

let scriptedTypeKeys =
    [ "scripted_trigger"; "scripted_effect"; "script_value" ]

let semanticDeltaForPath (path: string) =
    let lp = path.ToLowerInvariant().Replace('\\', '/')
    let domains =
        seq {
            if lp.EndsWith(".yml") then yield "localisation"
            if lp.Contains("/interface/") || lp.Contains("/gfx/") then yield "sprites_sounds"
        }
        |> Set.ofSeq
    { domains = domains
      changedTypeKeys = Set.empty
      localisationKeys = Set.empty
      dynamicDefinitions = if isDynamicDefinitionPath path then Set.singleton path else Set.empty
      callSites = Set.empty
      completionVisible = isTypeDefiningPath path
      validationVisible = true }

/// Refine the path-based delta with the actual staged type-index result. Until
/// every game exposes a complete semantic contribution delta, a reported
/// semantic change remains a conservative full-refresh request.
let semanticDeltaForTypeIndex path changedTypeKeys semanticChanged =
    let routed = semanticDeltaForPath path
    let domains =
        if semanticChanged then
            Set.union routed.domains (Set.ofList [ "types"; "rules" ])
        else
            routed.domains
    { domains = domains
      changedTypeKeys =
        if semanticChanged then changedTypeKeys |> Set.ofSeq else Set.empty
      localisationKeys = routed.localisationKeys
      dynamicDefinitions =
        if semanticChanged then routed.dynamicDefinitions else Set.empty
      callSites = routed.callSites
      completionVisible = semanticChanged
      // This function is called after a staged type-index comparison. A path
      // being generally validation-capable is not evidence of an unknown
      // semantic change; comment/format-only edits must remain true no-ops.
      validationVisible = semanticChanged }

let refreshDomainsForPath path = (semanticDeltaForPath path).domains |> Set.toList

/// True when the staged delta proves the file contributed a type, rule,
/// enum, scope, or service-dependency change. Path-based fast-paths alone
/// are not enough; this predicate looks at the actual changed sets.
let hasTypeDefiningDelta (delta: SemanticDelta) =
    not (Set.isEmpty delta.changedTypeKeys)
    || not (Set.isEmpty delta.dynamicDefinitions)
    || Set.contains "types" delta.domains
    || Set.contains "rules" delta.domains
    || (delta.validationVisible && not (Set.isEmpty delta.localisationKeys))

/// Decide whether a staged change can be committed incrementally, needs only a
/// scripted-service update, or must fall back to a full RefreshCaches. The
/// budget argument bounds consecutive scripted-service patches before a full
/// rebuild is forced for safety.
let decideSemanticDelta (delta: SemanticDelta) patchCount patchBudget =
    let hasTypeKeys = not (Set.isEmpty delta.changedTypeKeys)
    let hasDynamic = not (Set.isEmpty delta.dynamicDefinitions)
    let hasLoc = not (Set.isEmpty delta.localisationKeys)
    let hasSprites = Set.contains "sprites_sounds" delta.domains
    let hasUnknownSemanticChange =
        delta.validationVisible
        && not (hasTypeKeys || hasDynamic || hasLoc || hasSprites)
    let patchBudgetExceeded = hasDynamic && patchCount >= patchBudget
    if not (hasTypeKeys || hasDynamic || hasLoc || hasSprites || hasUnknownSemanticChange) then
        SemanticNoOp
    elif hasUnknownSemanticChange || patchBudgetExceeded then
        FullRefresh "unsafe_change_or_patch_budget_exceeded"
    elif hasDynamic then
        ScriptedServices
    elif hasTypeKeys then
        TypeIndexOnly
    else
        // Sprite or localisation surface changes are routed to their own
        // refresh paths; they do not require a full RefreshCaches.
        SemanticNoOp
