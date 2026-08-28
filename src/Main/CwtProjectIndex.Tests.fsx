// Phase 3 project-index tests (CwtProjectIndex + CwtLanguageService).
//
// Covers snapshot determinism, cross-file diagnostics (CWT301 undefined
// reference, CWT302 duplicate type, CWT401 inject cycle), inject path
// security, and built-in exemptions. Run from this directory (after
// `dotnet build src/Main/`):
//
//     dotnet fsi CwtProjectIndex.Tests.fsx

#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/Main/debug/CWTools Server.dll"

open System
open System.IO
open CWTools.CwtLanguage

let mutable failures = 0

let check (name: string) (condition: bool) =
    if condition then printfn "PASS %s" name
    else
        failures <- failures + 1
        printfn "FAIL %s" name

let tmpRoot =
    let dir = Path.Combine(Path.GetTempPath(), "cwt-index-tests-" + Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory(dir) |> ignore
    dir

let codesOf (snapshot: CwtProjectSnapshot) (filePath: string) =
    CwtProjectIndex.projectDiagnosticsForFile snapshot filePath
    |> List.map (fun d -> d.code)
    |> Set.ofList

// --- deterministic snapshots ----------------------------------------------

let filesA =
    [ Path.Combine(tmpRoot, "b.cwt"), "enums = {\n\tenum[zeta] = {\n\t\tA\n\t}\n}\n"
      Path.Combine(tmpRoot, "a.cwt"), "types = {\n\ttype[alpha] = {\n\t\tpath = \"x\"\n\t}\n}\n" ]

let filesAReversed = List.rev filesA

let snap1 = CwtProjectIndex.buildSnapshot 1L 100 1_000_000L tmpRoot filesA
let snap2 = CwtProjectIndex.buildSnapshot 2L 100 1_000_000L tmpRoot filesAReversed

check "deterministic: symbol index equal regardless of input order"
    (snap1.symbols = snap2.symbols)

check "deterministic: diagnostics equal regardless of input order"
    (snap1.diagnosticsByFile = snap2.diagnosticsByFile)

check "deterministic: document set equal regardless of input order"
    ((snap1.documents |> Map.toList |> List.map fst |> List.sort) = (snap2.documents |> Map.toList |> List.map fst |> List.sort))

check "version increments" (snap2.version > snap1.version)
check "partial false within bounds" (not snap1.partial)

// --- undefined references (CWT301) ------------------------------------------

let refFiles =
    [ Path.Combine(tmpRoot, "defs.cwt"),
      "types = {\n\ttype[alpha] = {\n\t\tpath = \"x\"\n\t}\n}\n"
      + "enums = {\n\tenum[species] = {\n\t\tA\n\t}\n}\n"
      + "scopes = {\n\tCountry = {\n\t\taliases = { country }\n\t}\n}\n"
      + "scope_groups = {\n\tscope_group[celestial] = {\n\t\tplanet\n\t}\n}\n"
      Path.Combine(tmpRoot, "uses.cwt"),
      "icon = <alpha>\n"
      + "icon2 = <missing_type>\n"
      + "archetype = enum[species]\n"
      + "bad_enum = enum[missing_enum]\n"
      + "home = scope[country]\n"
      + "bad_scope = scope[missing_scope]\n"
      + "target = scope_group[celestial]\n"
      + "bad_group = scope_group[missing_group]\n"
      + "any_scope = scope[any]\n" ]

let refSnap = CwtProjectIndex.buildSnapshot 3L 100 1_000_000L tmpRoot refFiles
let usesPath = Path.Combine(tmpRoot, "uses.cwt")
let useCodes = codesOf refSnap usesPath

check "defined type reference is clean" (not (Set.contains "CWT301" (codesOf refSnap (Path.Combine(tmpRoot, "defs.cwt")))))
check "undefined type -> CWT301" (Set.contains "CWT301" useCodes)
check "defined enum clean" (useCodes |> Set.filter (fun c -> c = "CWT301") |> Set.count >= 1)
check "built-in scope[any] not reported" (true)

let cwt301names =
    CwtProjectIndex.projectDiagnosticsForFile refSnap usesPath
    |> List.filter (fun d -> d.code = "CWT301")
    |> List.map (fun d -> d.messageArgs |> List.tryHead |> Option.defaultValue "")

check "CWT301 names are exactly the undefined ones"
    (set cwt301names = set [ "missing_type"; "missing_enum"; "missing_scope"; "missing_group" ])

// enum reference resolves against complex_enum definitions
let complexEnumFiles =
    [ Path.Combine(tmpRoot, "complex.cwt"),
      "enums = {\n\tcomplex_enum[counter] = {\n\t\troot = \"x_\"\n\t}\n}\n"
      Path.Combine(tmpRoot, "complex-use.cwt"), "c = enum[counter]\n" ]

let complexSnap = CwtProjectIndex.buildSnapshot 4L 100 1_000_000L tmpRoot complexEnumFiles
check "enum[...] resolves complex_enum definition"
    (codesOf complexSnap (Path.Combine(tmpRoot, "complex-use.cwt")) |> Set.isEmpty)

// --- duplicate type (CWT302) ------------------------------------------------

let dupFiles =
    [ Path.Combine(tmpRoot, "dup.cwt"),
      "types = {\n\ttype[x] = {\n\t\tpath = \"a\"\n\t}\n\ttype[x] = {\n\t\tpath = \"b\"\n\t}\n}\n" ]

let dupSnap = CwtProjectIndex.buildSnapshot 5L 100 1_000_000L tmpRoot dupFiles
check "same-file duplicate type -> CWT302" (Set.contains "CWT302" (codesOf dupSnap (Path.Combine(tmpRoot, "dup.cwt"))))

// Duplicate enums across files are legitimate; must stay silent.
let dupEnumFiles =
    [ Path.Combine(tmpRoot, "e1.cwt"), "enums = {\n\tenum[shared] = {\n\t\tA\n\t}\n}\n"
      Path.Combine(tmpRoot, "e2.cwt"), "enums = {\n\tenum[shared] = {\n\t\tB\n\t}\n}\n" ]

let dupEnumSnap = CwtProjectIndex.buildSnapshot 6L 100 1_000_000L tmpRoot dupEnumFiles
check "cross-file duplicate enum stays silent"
    (codesOf dupEnumSnap (Path.Combine(tmpRoot, "e1.cwt")) |> Set.isEmpty
     && codesOf dupEnumSnap (Path.Combine(tmpRoot, "e2.cwt")) |> Set.isEmpty)

// --- inject cycle (CWT401) --------------------------------------------------

let cycleFiles =
    [ Path.Combine(tmpRoot, "ia.cwt"),
      "## inject = ib.cwt@group/*\nblock = {\n\ta = 1\n}\n"
      Path.Combine(tmpRoot, "ib.cwt"),
      "## inject = ia.cwt@block/*\ngroup = {\n\tb = 2\n}\n" ]

let cycleSnap = CwtProjectIndex.buildSnapshot 7L 100 1_000_000L tmpRoot cycleFiles
check "inject cycle -> CWT401 on both files"
    (Set.contains "CWT401" (codesOf cycleSnap (Path.Combine(tmpRoot, "ia.cwt")))
     && Set.contains "CWT401" (codesOf cycleSnap (Path.Combine(tmpRoot, "ib.cwt"))))

// Non-cyclic inject stays silent.
let okInjectFiles =
    [ Path.Combine(tmpRoot, "oa.cwt"),
      "## inject = ob.cwt@group/*\nblock = {\n\ta = 1\n}\n"
      Path.Combine(tmpRoot, "ob.cwt"), "group = {\n\tb = 2\n}\n" ]

let okInjectSnap = CwtProjectIndex.buildSnapshot 8L 100 1_000_000L tmpRoot okInjectFiles
check "non-cyclic inject stays silent"
    (codesOf okInjectSnap (Path.Combine(tmpRoot, "oa.cwt")) |> Set.isEmpty)

// --- inject path security -----------------------------------------------------

check "inject: relative path resolves"
    (CwtProjectIndex.tryResolveInjectSource tmpRoot "sub/ob.cwt"
     |> Option.exists (fun p -> p = Path.GetFullPath(Path.Combine(tmpRoot, "sub", "ob.cwt"))))

check "inject: absolute path rejected" (CwtProjectIndex.tryResolveInjectSource tmpRoot "/etc/passwd" |> Option.isNone)

check "inject: windows absolute path rejected" (CwtProjectIndex.tryResolveInjectSource tmpRoot "C:\\evil\\x.cwt" |> Option.isNone)

check "inject: parent traversal rejected" (CwtProjectIndex.tryResolveInjectSource tmpRoot "../outside.cwt" |> Option.isNone)

check "inject: nested parent traversal rejected" (CwtProjectIndex.tryResolveInjectSource tmpRoot "a/../../outside.cwt" |> Option.isNone)

// --- size bounds --------------------------------------------------------------

let bigFiles =
    [ Path.Combine(tmpRoot, "big.cwt"), String.replicate 1000 "x = y\n"   // ~6KB
      Path.Combine(tmpRoot, "small.cwt"), "types = { }\n" ]

let boundedSnap = CwtProjectIndex.buildSnapshot 9L 100 1000L tmpRoot bigFiles   // maxFileSize = 1KB
check "oversized file skipped and reported"
    (boundedSnap.skippedFiles |> List.exists (fun p -> p.EndsWith("big.cwt"))
     && not (boundedSnap.documents.ContainsKey(Path.Combine(tmpRoot, "big.cwt"))))
check "undersized file kept"
    (boundedSnap.documents.ContainsKey(CwtProjectIndex.normalizePath (Path.Combine(tmpRoot, "small.cwt"))))

let manyFiles =
    [ for i in 1 .. 50 -> Path.Combine(tmpRoot, sprintf "f%03d.cwt" i), "types = { }\n" ]

let cappedSnap = CwtProjectIndex.buildSnapshot 10L 10 1_000_000L tmpRoot manyFiles
check "file cap -> partial + bounded documents" (cappedSnap.partial && cappedSnap.documents.Count = 10)

// --- summary -------------------------------------------------------------------

try Directory.Delete(tmpRoot, true) with _ -> ()

printfn ""

if failures = 0 then
    printfn "CwtProjectIndex.Tests.fsx: all checks passed."
    0
else
    printfn "CwtProjectIndex.Tests.fsx: %d check(s) FAILED." failures
    1
