module Main.AuraLocalisation

open System
open System.Globalization
open CWTools.Parser
open CWTools.Process
open CWTools.Utilities.Position
open CWTools.Utilities.Utils
open FParsec

/// Which aura flavour a generated tooltip belongs to.
type AuraKind =
    | Friendly
    | Hostile

/// One generated localisation entry: the aura block it came from plus the
/// ready-to-paste localisation line.
type AuraLocEntry =
    { Key: string
      Kind: AuraKind
      StartLine: int
      Text: string }

/// Outcome of a generation request. The LSP layer forwards this verbatim, so
/// every failure mode is reported as data instead of an exception.
type AuraGenResult =
    { Ok: bool
      Scope: string
      Entries: AuraLocEntry list
      Lines: string list
      Messages: string list }

let scopeBlock = "block"
let scopeFile = "file"

/// Modifier keys whose value the game renders as a percentage.
let private ratioSuffixes = [ "_mult"; "_mult_base"; "_perc"; "_percent" ]

/// The engine decides percentage vs flat rendering from its own modifier
/// registration, which the bundled rules do not carry (`config/logs/modifiers.log`
/// only holds name + scope category). These two tables are the manual escape
/// hatch for keys the suffix/fraction heuristic gets wrong.
let private forcePercentKeys: Set<string> = Set.empty
let private forceFlatKeys: Set<string> = Set.empty

let private skippedModifierKeys = Set.ofList [ "custom_tooltip"; "show_only_custom_tooltip" ]

/// Emitted in this order so repeated runs produce identical text.
let private damageFields =
    [ "shield_damage", "护盾伤害"
      "armor_damage", "装甲伤害"
      "hull_damage", "船体伤害"
      "accuracy", "命中率"
      "shield_penetration", "护盾穿透"
      "armor_penetration", "装甲穿透"
      "size_damage_factor", "体积伤害系数" ]

/// `enum[aura_types]` is `ships | fleets`; unknown values fall back to the raw token.
let private applyOnLabels = [ "ships", "舰船"; "fleets", "舰队" ]

let private auraKindOfNode (node: Node) : AuraKind option =
    if String.Equals(node.Key, "hostile_aura", StringComparison.OrdinalIgnoreCase) then Some Hostile
    elif String.Equals(node.Key, "friendly_aura", StringComparison.OrdinalIgnoreCase) then Some Friendly
    else None

let private childByKey (node: Node) (key: string) =
    node.Nodes
    |> Seq.tryFind (fun child -> String.Equals(child.Key, key, StringComparison.OrdinalIgnoreCase))

let private leafByKey (node: Node) (key: string) =
    node.Values
    |> List.tryFind (fun leaf -> String.Equals(leaf.Key, key, StringComparison.OrdinalIgnoreCase))

let private tryDecimal (leaf: Leaf) =
    match leaf.Value with
    | Value.Int value -> Some(decimal value)
    | Value.Float value -> Some value
    | _ ->
        match Decimal.TryParse(leaf.ValueText, NumberStyles.Float, CultureInfo.InvariantCulture) with
        | true, parsed -> Some parsed
        | _ -> None

let private hasFraction (value: decimal) = Decimal.Truncate value <> value

let private formatDecimal (value: decimal) =
    let rounded = Decimal.Round(value, 4, MidpointRounding.AwayFromZero)
    let text = rounded.ToString(CultureInfo.InvariantCulture)
    if text.Contains '.' then text.TrimEnd('0').TrimEnd('.') else text

let private isPercentKey (key: string) =
    let lowered = key.ToLowerInvariant()
    if forceFlatKeys.Contains lowered then false
    elif forcePercentKeys.Contains lowered then true
    else ratioSuffixes |> List.exists (fun suffix -> lowered.EndsWith(suffix, StringComparison.Ordinal))

/// `0.5` with a percent key becomes `50%`; plain integers stay as written.
let private renderMagnitude (percent: bool) (value: decimal) =
    let scaled = if percent then abs value * 100m else abs value
    formatDecimal scaled + (if percent then "%" else "")

let private renderModifierValue (key: string) (value: decimal) =
    let body = renderMagnitude (isPercentKey key || hasFraction value) value
    if value < 0m then "§R-" + body + "§!" else "§G+" + body + "§!"

let private renderDamageValue (value: decimal) =
    let body = renderMagnitude (hasFraction value) value
    if value < 0m then "§R-" + body + "§!" else "§G" + body + "§!"

let private modifierEntries (aura: Node) =
    aura.Nodes
    |> Seq.filter (fun child -> String.Equals(child.Key, "modifier", StringComparison.OrdinalIgnoreCase))
    |> Seq.collect (fun modifier -> modifier.Values)
    |> Seq.filter (fun leaf -> not (skippedModifierKeys.Contains(leaf.Key.ToLowerInvariant())))
    |> Seq.choose (fun leaf ->
        tryDecimal leaf
        |> Option.map (fun value -> "$MOD_" + leaf.Key.ToUpperInvariant() + "$", renderModifierValue leaf.Key value))
    |> Seq.toList

let private damageRangeEntry (damagePerDay: Node) =
    match childByKey damagePerDay "damage" with
    | None -> None
    | Some damage ->
        let bounds =
            [ leafByKey damage "min"; leafByKey damage "max" ]
            |> List.choose (Option.bind tryDecimal)
        match bounds with
        | [] -> None
        | minValue :: maxValue :: _ when minValue <> maxValue ->
            Some("每日伤害", "§G" + renderMagnitude false minValue + "-" + renderMagnitude false maxValue + "§!")
        | first :: _ -> Some("每日伤害", "§G" + renderMagnitude false first + "§!")

let private damageEntries (aura: Node) =
    match childByKey aura "damage_per_day" with
    | None -> []
    | Some damagePerDay ->
        (damageRangeEntry damagePerDay |> Option.toList)
        @ (damageFields
           |> List.choose (fun (field, heading) ->
               leafByKey damagePerDay field
               |> Option.bind tryDecimal
               |> Option.map (fun value -> heading, renderDamageValue value)))

let private auraKey (aura: Node) =
    let candidates =
        [ childByKey aura "stack_info" |> Option.bind (fun stack -> leafByKey stack "id")
          leafByKey aura "name" ]
        |> List.choose (Option.map (fun leaf -> leaf.ValueText.Trim()))
    candidates
    |> List.tryFind (fun candidate -> not (String.IsNullOrWhiteSpace candidate))

let private auraTarget (kind: AuraKind) (aura: Node) =
    let applyOn =
        leafByKey aura "apply_on"
        |> Option.map (fun leaf -> leaf.ValueText.Trim().ToLowerInvariant())
        |> Option.filter (fun value -> not (String.IsNullOrWhiteSpace value))
        |> Option.defaultValue ""
    let target =
        match applyOnLabels |> List.tryFind (fun (key, _) -> key = applyOn) with
        | Some(_, heading) -> heading
        | None -> applyOn
    (match kind with
     | Friendly -> "对盟友"
     | Hostile -> "对敌方")
    + target
    + "效果："

let private tryEntry (aura: Node) (kind: AuraKind) : AuraLocEntry option =
    match auraKey aura with
    | None -> None
    | Some key ->
        let header = match kind with Friendly -> "防御性光环" | Hostile -> "敌对光环"
        let body =
            [ yield "§Y" + header + "§!"
              yield auraTarget kind aura
              for heading, value in modifierEntries aura @ damageEntries aura do
                  yield " " + heading + "：" + value ]
            |> String.concat "\\n"
        Some { Key = key; Kind = kind; StartLine = int aura.Position.StartLine; Text = body }

/// Re-parse the buffer text instead of reading the game model, so output always
/// reflects what the editor shows.
let parseText (path: string) (text: string) : Node option =
    match CKParser.parseString text path with
    | Success(statements, _, _) -> Some(ProcessCore.processNodeBasic "root" (mkZeroFile path) statements)
    | _ -> None

let findAuras (root: Node) : (Node * AuraKind) list =
    let rec visit (node: Node) =
        seq {
            match auraKindOfNode node with
            | Some kind -> yield node, kind
            | None -> ()
            for child in node.Nodes do
                yield! visit child
        }
    visit root
    |> Seq.toList
    |> List.sortBy (fun (node, _) -> int node.Position.StartLine, int node.Position.StartColumn)

/// Innermost aura block containing the position, if any.
let findAuraAt (root: Node) (position: pos) : (Node * AuraKind) option =
    let rec descend (node: Node) (found: (Node * AuraKind) option) =
        let found =
            match auraKindOfNode node with
            | Some kind when rangeContainsPos node.Position position -> Some(node, kind)
            | _ -> found
        node.Nodes
        |> Seq.filter (fun child -> rangeContainsPos child.Position position)
        |> Seq.fold (fun acc child -> descend child acc) found
    descend root None

let kindName (kind: AuraKind) =
    match kind with
    | Friendly -> "friendly"
    | Hostile -> "hostile"

/// Cheap pre-check for the code-action path, which runs on every cursor move.
let containsAuraKey (text: string) =
    text.Contains("friendly_aura", StringComparison.OrdinalIgnoreCase)
    || text.Contains("hostile_aura", StringComparison.OrdinalIgnoreCase)

let hasAuraAt (path: string) (text: string) (position: pos) =
    parseText path text
    |> Option.bind (fun root -> findAuraAt root position)
    |> Option.isSome

/// Aura blocks live in `common/component_templates/*.txt`.
let isComponentTemplatePath (path: string) =
    let normalized = path.Replace('\\', '/').ToLowerInvariant()
    normalized.EndsWith(".txt", StringComparison.Ordinal)
    && normalized.Contains("/common/component_templates/")

let private renderLine (entry: AuraLocEntry) = entry.Key + ":0 \"" + entry.Text + "\""

let private emptyResult scope messages =
    { Ok = false; Scope = scope; Entries = []; Lines = []; Messages = messages }

let collect (path: string) (text: string) (scope: string) (position: pos option) : AuraGenResult =
    let scope =
        if String.Equals(scope, scopeFile, StringComparison.OrdinalIgnoreCase) then scopeFile else scopeBlock

    match parseText path text with
    | None -> emptyResult scope [ "无法解析当前文件：存在语法错误，请先修复后再生成" ]
    | Some root ->
        let candidates, missingPosition =
            if scope = scopeFile then findAuras root, false
            else
                match position with
                | Some value -> findAuraAt root value |> Option.toList, false
                | None -> [], true

        if candidates.IsEmpty then
            let message =
                if missingPosition then "缺少光标位置参数"
                elif scope = scopeFile then "当前文件未找到 friendly_aura / hostile_aura 块"
                else "光标不在 friendly_aura / hostile_aura 块内"
            emptyResult scope [ message ]
        else
            let generated, skipped =
                candidates
                |> List.fold (fun (entries, messages) (aura, kind) ->
                    match tryEntry aura kind with
                    | Some entry -> entry :: entries, messages
                    | None ->
                        entries,
                        sprintf
                            "第 %d 行的 %s 块既没有 stack_info.id 也没有 name，已跳过"
                            (int aura.Position.StartLine)
                            aura.Key
                        :: messages) ([], [])

            let entries, duplicates =
                generated
                |> List.rev
                |> List.fold (fun (entries, messages) entry ->
                    if entries
                       |> List.exists (fun existing -> String.Equals(existing.Key, entry.Key, StringComparison.OrdinalIgnoreCase)) then
                        entries, sprintf "重复的本地化键 %s（第 %d 行）已忽略" entry.Key entry.StartLine :: messages
                    else entry :: entries, messages) ([], [])

            let entries = List.rev entries
            let messages = List.rev skipped @ List.rev duplicates

            { Ok = not entries.IsEmpty
              Scope = scope
              Entries = entries
              Lines = entries |> List.map renderLine
              Messages = messages }
