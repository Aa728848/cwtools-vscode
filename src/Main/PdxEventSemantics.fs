module Main.PdxEventSemantics

open System
open CWTools.Games
open CWTools.Process

/// Derive every concrete event block/call operator from the active event
/// TypeDef. Stellaris adds new event subtypes over time, so analysis must not
/// freeze the list in the extension release that happened to introduce it.
let eventCallOperators (game: IGame<'T>) =
    game.TypeDefs()
    |> Seq.filter (fun typeDef -> typeDef.name.Equals("event", StringComparison.OrdinalIgnoreCase))
    |> Seq.collect (fun typeDef ->
        seq {
            match typeDef.typeKeyFilter with
            | Some(values, false) -> yield! values
            | _ -> ()
            for subtype in typeDef.subtypes do
                yield! subtype.typeKeyField |> Option.toList
        })
    |> Seq.map (fun value -> value.Trim().Trim('"').ToLowerInvariant())
    |> Seq.filter (fun value -> value.EndsWith("_event", StringComparison.Ordinal))
    |> Set.ofSeq
    |> Set.add "fire_on_action"

/// Standalone block tests do not have an IGame. Discover event-shaped
/// operators from the parsed block instead of reintroducing a static table.
let eventCallOperatorsInNode (root: Node) =
    let rec visit (node: Node) =
        seq {
            let key = node.Key.ToLowerInvariant()
            if key.EndsWith("_event", StringComparison.Ordinal) then yield key
            for value in node.Values do
                let valueKey = value.Key.ToLowerInvariant()
                if valueKey.EndsWith("_event", StringComparison.Ordinal) then yield valueKey
            for child in node.Nodes do yield! visit child
        }
    visit root |> Set.ofSeq |> Set.add "fire_on_action"
