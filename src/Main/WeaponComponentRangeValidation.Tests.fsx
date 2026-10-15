#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/Languages.dll"
#r "../../artifacts/bin/Main/debug/LSP.dll"

#load "../TestHelpers.fsx"

open System
open CWTools.Common
open Main.WeaponComponentRangeValidation
open TestHelpers

let harness = TestHarness("WeaponComponentRangeValidation")

let samplePath = "common/component_templates/probe.txt"

/// Templates that keep every value inside [0, 1].
let inRangeSample =
    """
weapon_component_template = {
	key = "PROBE_IN_RANGE"
	accuracy = 0.85
	tracking = 0.5
	min_damage = 10
}

weapon_component_template = {
	key = "PROBE_BOUNDARY"
	accuracy = 0
	tracking = 1
}
"""

/// The engine rejects these with "should be between 0.0 and 1.0".
let outOfRangeSample =
    """
weapon_component_template = {
	key = "PROBE_ACCURACY_HIGH"
	accuracy = 1.5
	tracking = 0.5
}

weapon_component_template = {
	key = "PROBE_TRACKING_LOW"
	accuracy = 0.85
	tracking = -0.25
}

weapon_component_template = {
	key = "PROBE_INT_OVER"
	accuracy = 2
}
"""

/// Neither field present at all: nothing to decide.
let missingFieldsSample =
    """
weapon_component_template = {
	key = "PROBE_NO_FIELDS"
	min_damage = 10
	max_damage = 20
}
"""

/// Variables and script expressions are resolved by the game, so the lint stays silent.
let expressionSample =
    """
weapon_component_template = {
	key = "PROBE_EXPRESSIONS"
	accuracy = var:custom_accuracy
	tracking = @[add 0.5 my_tracking]
}
"""

// --- positive ---------------------------------------------------------------

let outOfRange = findings samplePath outOfRangeSample

harness.Equal "out-of-range literals produce one finding each" 3 outOfRange.Length
harness.Check
    "every finding carries the CW290 code"
    (outOfRange |> List.forall (fun f -> f.Code = "CW290"))
harness.Check
    "severity matches the value-range diagnostic family"
    (outOfRange |> List.forall (fun f -> f.Severity = Severity.Warning))

let fieldsAndValues =
    outOfRange |> List.map (fun f -> f.Field, f.Value)

harness.Equal "findings name the offending field and value" [ "accuracy", 1.5M; "tracking", -0.25M; "accuracy", 2M ] fieldsAndValues
harness.Check "in-range literals are silent" (findings samplePath inRangeSample |> List.isEmpty)
harness.Check "missing fields are silent" (findings samplePath missingFieldsSample |> List.isEmpty)
harness.Check "variable and script expressions are skipped" (findings samplePath expressionSample |> List.isEmpty)
harness.Check "a template of another subtype is not a weapon template" (
    findings samplePath "utility_component_template = { accuracy = 5.0 }" |> List.isEmpty)

// --- message ----------------------------------------------------------------

let firstMessage = (List.head outOfRange).Message

harness.Check "message states the engine range" (firstMessage.Contains "between 0.0 and 1.0")
harness.Check "message names the field" (firstMessage.Contains "accuracy")
harness.Check "message quotes the offending value" (firstMessage.Contains "1.5")

// --- localisation -----------------------------------------------------------

harness.Check "message is English server text like the rest of the CW pipeline" (
    firstMessage.StartsWith("Weapon component", System.StringComparison.Ordinal))

// --- publish tuple shape ----------------------------------------------------

let tuples = diagnostics samplePath outOfRangeSample

harness.Equal "diagnostics emit one tuple per finding" 3 tuples.Length

match tuples |> List.tryHead with
| Some first ->
    let (code, severity, fileName, message, range, keyLength, related) = first
    harness.Equal "tuple code" "CW290" code
    harness.Equal "tuple severity" Severity.Warning severity
    harness.Equal "tuple file" samplePath fileName
    harness.Equal "tuple message matches the finding" firstMessage message
    harness.Equal "tuple underlines the key" "accuracy".Length keyLength
    harness.Check "tuple carries no related information" (related.IsNone)
    harness.Check "tuple keeps the parsed position" (int range.StartLine = 4)
| None -> harness.Fail("tuple shape", "expected at least one diagnostic tuple")

// --- nested templates and ordering -------------------------------------------

let nestedSample =
    """
utility_component_template = {
	key = "PROBE_NESTED"
	accuracy = 9.0
	weapon_component_template = {
		key = "PROBE_NESTED_INNER"
		tracking = 4.0
	}
}

weapon_component_template = {
	key = "PROBE_LAST"
	accuracy = 3.0
}
"""

let nested = findings samplePath nestedSample

harness.Equal "only the nested weapon templates are reported" 2 nested.Length
harness.Equal
    "findings stay in source order"
    [ "tracking", 4M; "accuracy", 3M ]
    (nested |> List.map (fun f -> f.Field, f.Value))

// --- cheap pre-check --------------------------------------------------------

harness.Check "pre-check skips files without component templates" (
    not (mayContainWeaponTemplates "planet = { name = \"earth\" }"))
harness.Check "pre-check keeps component template files" (
    mayContainWeaponTemplates "utility_component_template = { key = \"a\" }")

// --- broken text ------------------------------------------------------------

harness.Check "unparsable text yields no findings instead of throwing" (
    findings samplePath "weapon_component_template = { accuracy = 1.5" |> List.isEmpty)

harness.Summary() |> ignore
