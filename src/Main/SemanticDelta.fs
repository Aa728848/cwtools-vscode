module Main.SemanticDelta

open System
open System.IO

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

type CommittedSemanticStage =
    | CommittedTypeIndex
    | CommittedScriptedServices

let typeDefiningExtensions =
    set [ ".txt"; ".gui"; ".gfx"; ".asset" ]

/// Conservative path-based hint for editor features. Core incremental routing
/// asks the active game capability for exact type keys, so this must not encode
/// any game's directory layout.
let isTypeDefiningPath (path: string) =
    typeDefiningExtensions.Contains(Path.GetExtension(path).ToLowerInvariant())

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
       "common/script_values/"
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

/// How "which files reference the definitions this file owns" is answered.
/// Type definitions are addressed by the value ids the shared type-reference
/// index is keyed on, so both events and the ordinary `type[...]` directories
/// resolve through that index. The scripted directories keep the exhaustive
/// reference scan because their definitions are not all addressable that way.
type ReferenceDiscovery =
    | TypeReferenceIndexLookup
    | ExhaustiveReferenceScan
    | NoReferenceDiscovery

let referenceDiscoveryForPath (path: string) =
    if isEventDefinitionPath path then
        TypeReferenceIndexLookup
    elif isDynamicDefinitionPath path then
        ExhaustiveReferenceScan
    elif isTypeDefiningPath path then
        TypeReferenceIndexLookup
    else
        NoReferenceDiscovery

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

/// Type keys are matched against `type[...]` declarations, which are addressed by
/// their base name; a key carrying a subtype qualifier names the same type.
let baseTypeKey (typeKey: string) =
    if isNull typeKey then
        ""
    else
        typeKey
        |> fun key -> key.Split('.').[0]
        |> fun baseKey -> baseKey.Trim().ToLowerInvariant()

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

/// True when a changed type key names an ordinary definition type, i.e. one
/// declared by CWT as `type[...]` (technology, event, building, ...). The rule
/// validation service freezes their value-id sets when it is constructed, so a
/// change to one of them cannot be published by a type-index commit alone.
let requiresScriptedServicesForTypeKeys (ordinaryTypeKeys: Set<string>) (changedTypeKeys: seq<string>) =
    changedTypeKeys
    |> Seq.exists (fun typeKey -> ordinaryTypeKeys.Contains(baseTypeKey typeKey))

/// True when removing a file must publish through the scripted-service path
/// instead of the type-index path. A deletion removes a value id from the set the
/// rule validation service froze at construction exactly the way an edit adds
/// one, so the two cases need the same signal: a scripted definition directory
/// (always) or a deleted definition whose type names an ordinary `type[...]`
/// declaration. An empty definition list names no key at all and therefore stays
/// on the cheap type-index path.
let deletionRequiresScriptedServices
    (path: string)
    (ordinaryTypeKeys: Set<string>)
    (definitions: (string * string) list) =
    isDynamicDefinitionPath path
    || requiresScriptedServicesForTypeKeys
        ordinaryTypeKeys
        (definitions |> Seq.map fst)

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

/// Once an atomic incremental stage has committed, that stage defines the safe
/// publication boundary. Editor saves must not be promoted to a full cache
/// rebuild merely because the generic delta is incomplete or a patch counter
/// reached its historical safety budget. `ordinaryTypeKeys` carries the `type[...]`
/// declaration names; a committed type-index stage that touched one of them is
/// escalated to a scripted-service publication regardless of the stage that
/// produced it.
let decideCommittedSemanticDelta stage semanticChanged delta ordinaryTypeKeys patchCount patchBudget =
    if semanticChanged then
        match stage with
        | CommittedTypeIndex ->
            // A committed type-index stage publishes no rebuilt services, so a change
            // to an ordinary `type[...]` key must still escalate. Otherwise the rule
            // validation service keeps the value set it froze at construction and
            // every referrer reports the changed definition as unknown until restart.
            if requiresScriptedServicesForTypeKeys ordinaryTypeKeys delta.changedTypeKeys then
                ScriptedServices
            else
                TypeIndexOnly
        | CommittedScriptedServices -> ScriptedServices
    else
        decideSemanticDelta delta patchCount patchBudget
