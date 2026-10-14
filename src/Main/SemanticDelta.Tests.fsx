#load "../TestHelpers.fsx"
#load "SemanticDelta.fs"

open Main.SemanticDelta
open TestHelpers

let assertEqual = assertEqualNamed

let unknownSemanticDelta =
    { semanticDeltaForPath "common/colony_automation_exceptions/test.txt" with
        domains = Set.ofList [ "types"; "rules" ]
        completionVisible = true
        validationVisible = true }

/// Stands in for the `type[...]` declaration names CWT reports through
/// `IGame.TypeDefs()`. Ordinary definition types, not the scripted ones.
let ordinaryTypeKeys = set [ "technology"; "event"; "building"; "trait" ]

let ordinaryTypeDelta typeKeys =
    { semanticDeltaForPath "common/technology/energy.txt" with
        domains = Set.ofList [ "types"; "rules" ]
        changedTypeKeys = Set.ofList typeKeys
        completionVisible = true
        validationVisible = true }

assertEqual
    "generic unknown semantic changes remain conservative"
    (FullRefresh "unsafe_change_or_patch_budget_exceeded")
    (decideSemanticDelta unknownSemanticDelta 0 25)

assertEqual
    "committed type-index saves never promote to a full refresh"
    TypeIndexOnly
    (decideCommittedSemanticDelta
        CommittedTypeIndex
        true
        unknownSemanticDelta
        ordinaryTypeKeys
        25
        25)

assertEqual
    "committed scripted-service saves ignore the historical patch budget"
    ScriptedServices
    (decideCommittedSemanticDelta
        CommittedScriptedServices
        true
        unknownSemanticDelta
        ordinaryTypeKeys
        25
        25)

// The rule validation service freezes the value-id set of every `type[...]` key at
// construction, so a committed type-index stage that touched one of them cannot be
// published on its own: referrers would keep reporting the definition as unknown.
assertEqual
    "an ordinary type key escalates a committed type-index stage to scripted services"
    ScriptedServices
    (decideCommittedSemanticDelta
        CommittedTypeIndex
        true
        (ordinaryTypeDelta [ "technology" ])
        ordinaryTypeKeys
        0
        25)

assertEqual
    "a subtype-qualified ordinary type key escalates as well"
    ScriptedServices
    (decideCommittedSemanticDelta
        CommittedTypeIndex
        true
        (ordinaryTypeDelta [ "technology.physics" ])
        ordinaryTypeKeys
        0
        25)

assertEqual
    "changed keys outside the type declarations stay on the cheap type-index path"
    TypeIndexOnly
    (decideCommittedSemanticDelta
        CommittedTypeIndex
        true
        (ordinaryTypeDelta [ "planet_civic" ])
        ordinaryTypeKeys
        0
        25)

assertEqual
    "an escalated key still ignores the historical scripted patch budget"
    ScriptedServices
    (decideCommittedSemanticDelta
        CommittedTypeIndex
        true
        (ordinaryTypeDelta [ "event" ])
        ordinaryTypeKeys
        25
        25)

// A body/range-only edit of an ordinary type file must stay the cheapest
// possible publication: no semantic change means no services and no invalidation.
assertEqual
    "a non-semantic ordinary-type edit stays a no-op"
    SemanticNoOp
    (decideCommittedSemanticDelta
        CommittedTypeIndex
        false
        (semanticDeltaForTypeIndex "common/technology/energy.txt" [ "technology" ] false)
        ordinaryTypeKeys
        0
        25)

assertTrueNamed
    "requiresScriptedServicesForTypeKeys accepts a declared key"
    (requiresScriptedServicesForTypeKeys ordinaryTypeKeys [ "TECHNOLOGY" ])

assertFalseNamed
    "requiresScriptedServicesForTypeKeys rejects an undeclared key"
    (requiresScriptedServicesForTypeKeys ordinaryTypeKeys [ "unknown_key" ])

// Deleting a definition withdraws its value id from the frozen type set exactly
// like an edit adds one, so the deletion path escalates on the same signal.
assertTrueNamed
    "deletionRequiresScriptedServices escalates a deleted ordinary type key"
    (deletionRequiresScriptedServices
        "common/technology/zzz_tech.txt"
        ordinaryTypeKeys
        [ ("technology", "energy_1")
          ("technology", "physics_1") ])

assertTrueNamed
    "deletionRequiresScriptedServices escalates a deleted event key"
    (deletionRequiresScriptedServices
        "common/events/zzz_events.txt"
        ordinaryTypeKeys
        [ ("event", "my_event.1") ])

assertTrueNamed
    "deletionRequiresScriptedServices escalates a subtype-qualified deleted key"
    (deletionRequiresScriptedServices
        "common/technology/zzz_tech.txt"
        ordinaryTypeKeys
        [ ("technology.physics", "physics_1") ])

assertTrueNamed
    "deletionRequiresScriptedServices matches the deleted key case-insensitively"
    (deletionRequiresScriptedServices
        "common/buildings/zzz_auto.txt"
        ordinaryTypeKeys
        [ ("  Building ", "auto_1") ])

assertFalseNamed
    "deletionRequiresScriptedServices leaves undeclared keys on the type-index path"
    (deletionRequiresScriptedServices
        "common/colony_automation_exceptions/zzz.txt"
        ordinaryTypeKeys
        [ ("planet_civic", "some_planet") ])

assertFalseNamed
    "deletionRequiresScriptedServices keeps a definition-less deletion cheap"
    (deletionRequiresScriptedServices "common/technology/zzz_tech.txt" ordinaryTypeKeys [])

assertTrueNamed
    "deletionRequiresScriptedServices keeps scripted directories scripted with no definitions"
    (deletionRequiresScriptedServices "common/scripted_effects/zzz_effect.txt" Set.empty [])

assertTrueNamed
    "deletionRequiresScriptedServices keeps inline scripts scripted with no definitions"
    (deletionRequiresScriptedServices "common/inline_scripts/zzz_script.txt" Set.empty [])

// Referrer discovery: an ordinary type definition file resolves through the shared
// type-reference index exactly like an event file, instead of returning no referrers.
assertEqual
    "technology definition files resolve referrers through the type reference index"
    TypeReferenceIndexLookup
    (referenceDiscoveryForPath "common/technology/energy.txt")

assertEqual
    "building definition files resolve referrers through the type reference index"
    TypeReferenceIndexLookup
    (referenceDiscoveryForPath "common/buildings/auto.txt")

assertEqual
    "gui asset files resolve referrers through the type reference index"
    TypeReferenceIndexLookup
    (referenceDiscoveryForPath "common/gfx/foo.gfx")

assertEqual
    "event files keep resolving referrers through the type reference index"
    TypeReferenceIndexLookup
    (referenceDiscoveryForPath "common/events/00_first_contact.txt")

assertEqual
    "scripted effects keep the exhaustive reference scan"
    ExhaustiveReferenceScan
    (referenceDiscoveryForPath "common/scripted_effects/zzz_effect.txt")

assertEqual
    "static modifiers keep the exhaustive reference scan"
    ExhaustiveReferenceScan
    (referenceDiscoveryForPath "common/static_modifiers/foo.txt")

assertEqual
    "localisation files never participate in reference discovery"
    NoReferenceDiscovery
    (referenceDiscoveryForPath "localisation/english/zzz_l_english.yml")

printfn "SemanticDelta regression tests passed"
