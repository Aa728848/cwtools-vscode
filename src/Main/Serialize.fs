module Main.Serialize

open System.IO
open CWTools.Games.Files
open CWTools.Serializer

let private serializeToCache serializer outName folder cacheDirectory =
    serializer
        { WorkspaceDirectory.name = "vanilla"
          path = folder }
        (Some(Path.Combine(cacheDirectory, outName)))
        CWTools.CompressionOptions.NoCompression
    |> ignore

let serializeSTL = serializeToCache CWTools.Serializer.serializeSTL "stl.cwb"
let serializeEU4 = serializeToCache CWTools.Serializer.serializeEU4 "eu4.cwb"
let serializeHOI4 = serializeToCache CWTools.Serializer.serializeHOI4 "hoi4.cwb"
let serializeCK2 = serializeToCache CWTools.Serializer.serializeCK2 "ck2.cwb"
let serializeIR = serializeToCache CWTools.Serializer.serializeIR "ir.cwb"
let serializeVIC2 = serializeToCache CWTools.Serializer.serializeVIC2 "vic2.cwb"
let serializeCK3 = serializeToCache CWTools.Serializer.serializeCK3 "ck3.cwb"
let serializeVIC3 = serializeToCache CWTools.Serializer.serializeVIC3 "vic3.cwb"
let serializeEU5 = serializeToCache CWTools.Serializer.serializeEU5 "eu5.cwb"

let deserialize path =
    try
        let resources, files = deserialize path
        CWTools.Utilities.Utils.logInfo (sprintf "Cache loaded from %s: %d resources, %d files" path (List.length resources) (List.length files))
        resources, files
    with e ->
        CWTools.Utilities.Utils.logError (sprintf "Failed to deserialize cache %s: %s" path (e.ToString()))
        [], []
