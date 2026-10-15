module Main.WeaponComponentRangeValidation

open System
open System.Globalization
open CWTools.Common
open CWTools.Games
open CWTools.Parser
open CWTools.Process
open CWTools.Utilities.Position
open CWTools.Utilities.Utils
open FParsec

/// CW290 — a weapon component template field the engine reads as a probability but
/// the bundled CWT rules declare as an unconstrained `float`, so nothing else
/// reports an out-of-range literal.
///
/// The rules leave `accuracy = float` / `tracking = float` open
/// (config/common/components_consolidated.cwt), while the engine's weapon hit-chance
/// formula `p = clamp(accuracy - clamp(target_evasion - tracking, 0, 1), 0, 1)`
/// treats both as [0, 1] and logs "Accuracy / Tracking should be between 0.0 and
/// 1.0" otherwise. Assigned CW290 because docs/diagnostic-codes.md publishes
/// CW001-CW289 and states a published code never changes meaning; CW290 is the
/// next free slot, and CW270/CW271 (the sibling "value out of the shape the field
/// expects" findings) are both Warning, which is the severity used here too.
let diagnosticCode = "CW290"

let diagnosticSeverity = Severity.Warning

/// Fields whose value is a probability, not an arbitrary scalar.
let private boundedRatioFields = Set.ofList [ "accuracy"; "tracking" ]

let private minimum = 0M
let private maximum = 1M

/// One out-of-range literal, already located in the source file.
type ComponentRangeFinding =
    { Code: string
      Severity: Severity
      Field: string
      Value: decimal
      Range: range
      /// Matches ValidationCore.invData: the diagnostic underlines the key, not the
      /// whole `key = value` span the leaf position covers.
      KeyLength: int }

    member finding.Message =
        let text = finding.Value.ToString(CultureInfo.InvariantCulture)
        $"Weapon component '{finding.Field}' should be between 0.0 and 1.0, got {text}"

/// Only literal numbers are decidable at lint time. `var:x`, `@[...]`, `yes`
/// and quoted text are resolved by the game or by a later pass, so they stay silent.
let tryConstantNumber (leaf: Leaf) : decimal option =
    match leaf.Value with
    | Value.Float value -> Some value
    | Value.Int value -> Some(decimal value)
    | _ -> None

let isOutOfRange (value: decimal) = value < minimum || value > maximum

let private isWeaponComponentTemplate (node: Node) =
    String.Equals(node.Key, "weapon_component_template", StringComparison.OrdinalIgnoreCase)

let private leavesIn (node: Node) =
    node.Leaves
    |> Seq.choose (fun leaf ->
        if boundedRatioFields.Contains(leaf.Key.ToLowerInvariant()) then
            match tryConstantNumber leaf with
            | Some value when isOutOfRange value -> Some(leaf, value)
            | _ -> None
        else
            None)

/// Depth-first walk in source order so repeated runs report identically.
let rec private collectInOrder (node: Node) : ComponentRangeFinding list =
    let own =
        if isWeaponComponentTemplate node then
            leavesIn node
            |> Seq.map (fun (leaf, value) ->
                { Code = diagnosticCode
                  Severity = diagnosticSeverity
                  Field = leaf.Key.ToLowerInvariant()
                  Value = value
                  Range = leaf.Position
                  KeyLength = leaf.Key.Length })
            |> List.ofSeq
        else
            []

    // A template's own key = value lines precede its nested blocks in the file,
    // so emitting them first keeps the report in source order.
    own @ (node.Nodes |> Seq.collect collectInOrder |> List.ofSeq)

/// Cheap pre-check so the per-keystroke lint does not re-parse every script file.
let mayContainWeaponTemplates (text: string) =
    text.Contains("component_template", StringComparison.OrdinalIgnoreCase)

let findings (filePath: string) (text: string) : ComponentRangeFinding list =
    if not (mayContainWeaponTemplates text) then
        []
    else
        match CKParser.parseString text filePath with
        | Success(statements, _, _) ->
            let root = ProcessCore.processNodeBasic "root" (mkZeroFile filePath) statements
            collectInOrder root
        | _ -> []

/// Tuple shape consumed by Program.fs's publish pipeline:
/// (code, severity, fileName, message, range, keyLength, relatedErrors).
let toErrorTuple (finding: ComponentRangeFinding) =
    ( finding.Code
      , finding.Severity
      , finding.Range.FileName
      , finding.Message
      , finding.Range
      , finding.KeyLength
      , (None: (CWRelatedError list) option) )

let diagnostics (filePath: string) (text: string) =
    findings filePath text |> List.map toErrorTuple
