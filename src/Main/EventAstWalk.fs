module Main.EventAstWalk

open System
open CWTools.Process
let phaseOf (node: Node) : string =
    let key = node.Key.ToLowerInvariant()
    if key = "trigger" then "trigger"
    elif key = "immediate" then "immediate"
    elif key = "option" then "option"
    elif key = "hidden_effect" then "hidden_effect"
    elif key = "after" then "after"
    elif key = "on_success" then "on_success"
    elif key = "on_fail" then "on_fail"
    elif key = "potential" then "potential"
    elif key = "allow" then "allow"
    else ""

let conditionPathOf (path: string list) : string option =
    if path.IsEmpty then None
    else
        let ordered = path |> List.rev
        let role =
            if ordered |> List.exists (fun item -> item = "not" || item = "nor" || item = "else") then "blocks"
            elif ordered |> List.exists (fun item -> item = "or" || item = "random_list" || item = "switch" || item = "else_if") then "alternative"
            else "requires"
        Some(role + ":" + String.concat ">" ordered)

let eventScopeFromKey (key: string) : string option =
    let lower = key.ToLowerInvariant()
    if lower.EndsWith("_event", StringComparison.Ordinal) then
        Some(lower.Substring(0, lower.Length - 6))
    else
        None

let preferredSubjectKeys =
    Set.ofList [ "which"; "name"; "flag"; "id"; "target"; "technology"; "tech"; "project"; "situation"; "type" ]

let rawSubjectLeafFromNode (node: Node) : Leaf option =
    node.Leaves
    |> Seq.tryFind (fun leaf -> preferredSubjectKeys.Contains(leaf.Key.ToLowerInvariant()))
    |> Option.orElseWith (fun () -> node.Leaves |> Seq.tryHead)

let subjectFromNodeWith (transform: string -> string) (node: Node) : string option =
    rawSubjectLeafFromNode node
    |> Option.map (fun leaf -> transform (string leaf.Value) |> fun raw -> raw.Trim().Trim('"'))

let subjectFromNode (node: Node) : string option =
    subjectFromNodeWith id node
