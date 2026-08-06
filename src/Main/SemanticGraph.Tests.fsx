#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.DesignTime.dll"
#r "../../artifacts/bin/Main/debug/FSharp.Data.dll"

open Main.SemanticGraph

let private assertTrue name condition =
    if not condition then failwith name

let content = """sample = {
    modifier = { factor = 1 trigger = { has_country_flag = alpha } }
    modifier = { factor = 2 trigger = { has_country_flag = beta } }
    tag = one
    tag = two
}
"""

let parsed = CWTools.Parser.CKParser.parseString content "common/test/semantic.txt"
let root =
    match parsed with
    | FParsec.CharParsers.Success(files, _, _) ->
        CWTools.Process.STLProcess.simpleProcess.ProcessNode () "root" (CWTools.Utilities.Utils.mkZeroFile "common/test/semantic.txt") files
    | _ -> failwith "fixture parse failed"

let sample = root.Nodes |> Seq.find (fun node -> node.Key = "sample")
let fields = collectSemanticFields sample

assertTrue "duplicate scalar fields retain independent occurrences"
    (fields |> List.exists (fun field -> field.path = "tag[0]" && field.value = "one")
     && fields |> List.exists (fun field -> field.path = "tag[1]" && field.value = "two"))
assertTrue "nested anonymous blocks retain stable occurrence paths"
    (fields |> List.exists (fun field -> field.path = "modifier[0].factor[0]" && field.value = "1")
     && fields |> List.exists (fun field -> field.path = "modifier[1].trigger[0].has_country_flag[0]" && field.value = "beta"))
assertTrue "every semantic field carries a real source line"
    (fields |> List.forall (fun field -> field.line > 0 && field.file.EndsWith("common/test/semantic.txt")))

printfn "SemanticGraph recursive field regression tests passed"
