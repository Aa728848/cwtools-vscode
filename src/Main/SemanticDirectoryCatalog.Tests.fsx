#load "SemanticDirectoryCatalog.fs"

open Main.SemanticDirectoryCatalog

let private assertEqual expected actual message =
    if expected <> actual then
        failwithf "%s. Expected: %A; Actual: %A" message expected actual

assertEqual
    (Some "common/technologies")
    (Catalog.tryNormalizePath " game\\common\\technologies/ ")
    "game root and separators should normalize"

for invalid in [ ""; " "; "/common/x"; "C:\\game\\common"; "file://game/common"; "common/../events"; "common//events"; "common/<dynamic>"; "common/$variable"; "."; ".." ] do
    assertEqual None (Catalog.tryNormalizePath invalid) $"unsafe path should be rejected: {invalid}"

let catalog =
    Catalog.build
        [ "technology", [ "game/common/technologies"; "common\\technologies" ]
          "building", [ "common/technologies"; "common/buildings" ]
          "ignored", [ "../outside"; "https://example.test/path" ]
          "case_variant", [ "Common/Buildings" ] ]

assertEqual
    [ { path = "Common/Buildings"; entityTypes = [ "case_variant" ] }
      { path = "common/buildings"; entityTypes = [ "building" ] }
      { path = "common/technologies"; entityTypes = [ "building"; "technology" ] } ]
    catalog
    "catalog should merge entity types and sort deterministically"

printfn "SemanticDirectoryCatalog tests passed."
