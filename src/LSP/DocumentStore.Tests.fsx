#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/LSP/debug/LSP.dll"
#load "../TestHelpers.fsx"

open System
open System.IO
open LSP
open LSP.Types
open TestHelpers

withTempDir "cwtools-document-store" (fun tempRoot ->
    let path = Path.Combine(tempRoot, "Lifecycle.txt")
    let uri = Uri(path)
    let store = DocumentStore()
    store.Open
        { textDocument =
            { uri = uri
              languageId = "stellaris"
              version = 1
              text = "first" } }

    assertEqual (Some "first") (store.GetTextByPath(path)) "open text"
    assertEqual (Some 1) (store.GetVersionByPath(path)) "open version"

    store.Change
        { textDocument = { uri = uri; version = 2 }
          contentChanges =
            [ { range = None
                rangeLength = None
                text = "second" } ] }

    assertEqual (Some "second") (store.GetText(FileInfo(path))) "changed text"
    assertEqual (Some 2) (store.GetVersion(FileInfo(path))) "changed version"

    let alternatePath =
        if OperatingSystem.IsWindows() then
            path.Replace(char 92, '/').ToUpperInvariant()
        else path
    assertEqual (Some "second") (store.GetTextByPath(alternatePath)) "platform path identity lookup"

    store.CleanupOrphanedDocuments(Set.singleton alternatePath)
    assertEqual 1 (store.OpenFiles().Length) "normalized cleanup retains open document"

    store.Close { textDocument = { uri = uri } }
    assertEqual None (store.GetTextByPath(path)) "close removes document"
    assertEqual 0 (store.OpenFiles().Length) "close clears open files"

    store.Open
        { textDocument =
            { uri = uri
              languageId = "stellaris"
              version = 3
              text = "foo = bar_baz {\n  key = \"val\"\n}" } }

    assertEqual "bar_baz" (store.GetTextAtPosition(uri, { line = 0; character = 7 })) "GetTextAtPosition middle word"
    assertEqual "key" (store.GetTextAtPosition(uri, { line = 1; character = 2 })) "GetTextAtPosition start of line"
    assertEqual "" (store.GetTextAtPosition(uri, { line = 0; character = 4 })) "GetTextAtPosition on delimiter"
    store.CleanupOrphanedDocuments(Set.empty)
    assertEqual None (store.GetTextByPath(path)) "cleanup removes orphan")

printfn "DocumentStore platform lifecycle regression tests passed"
