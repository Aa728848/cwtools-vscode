namespace LSP

open System
open CSharpExtensions
open LSP.Log
open System.IO
open System.Collections.Generic
open System.Text
open Types

type private Version =
    { text: StringBuilder
      mutable version: int
      // 缓存 StringBuilder.ToString() 结果，避免热路径上重复分配字符串
      mutable cachedText: string
      mutable cachedVersion: int }

module DocumentStoreUtils =
    let findRange (text: StringBuilder, range: Range) : struct (int * int) =
        let mutable line = 0
        let mutable char = 0
        let mutable startOffset = 0
        let mutable endOffset = 0

        for offset = 0 to text.Length do
            if line = range.start.line && char = range.start.character then
                startOffset <- offset

            if line = range.``end``.line && char = range.``end``.character then
                endOffset <- offset

            if offset < text.Length then
                let c = text[offset]

                if c = '\n' then
                    line <- line + 1
                    char <- 0
                else
                    char <- char + 1

        (startOffset, endOffset)

open DocumentStoreUtils

[<Sealed>]
type DocumentStore() =
    /// All open documents, organized by absolute path
    let activeDocuments = Dictionary<string, Version>()

    /// 获取或创建文本缓存（同一版本只创建一次字符串）
    let getCachedText (v: Version) =
        if v.cachedVersion = v.version then
            v.cachedText
        else
            let text = v.text.ToString()
            v.cachedText <- text
            v.cachedVersion <- v.version
            text

    /// Replace a section of an open file
    let patch (doc: VersionedTextDocumentIdentifier, range: Range, text: string) : unit =
        let file = FileInfo(doc.uri.LocalPath)
        let existing = activeDocuments[file.FullName]
        let struct (startOffset, endOffset) = findRange (existing.text, range)
        existing.text.Remove(startOffset, endOffset - startOffset) |> ignore
        existing.text.Insert(startOffset, text) |> ignore
        existing.version <- doc.version

    /// Replace the entire contents of an open file
    let replace (doc: VersionedTextDocumentIdentifier, text: string) : unit =
        let file = FileInfo(doc.uri.LocalPath)
        let existing = activeDocuments[file.FullName]
        existing.text.Clear() |> ignore
        existing.text.Append(text) |> ignore
        existing.version <- doc.version

    member this.Open(doc: DidOpenTextDocumentParams) : unit =
        let file = FileInfo(doc.textDocument.uri.LocalPath)
        let text = StringBuilder(doc.textDocument.text)

        let version =
            { text = text
              version = doc.textDocument.version
              cachedText = doc.textDocument.text
              cachedVersion = doc.textDocument.version }

        activeDocuments[file.FullName] <- version

    member this.Change(doc: DidChangeTextDocumentParams) : unit =
        let file = FileInfo(doc.textDocument.uri.LocalPath)
        let found, existing = activeDocuments.TryGetValue(file.FullName)
        if not found then () else

        if doc.textDocument.version <= existing.version then
            let oldVersion = existing.version
            let newVersion = doc.textDocument.version
            dprintfn $"Change %d{newVersion} to doc %s{file.Name} is earlier than existing version %d{oldVersion}"
        else
            for change in doc.contentChanges do
                match change.range with
                | Some range -> patch (doc.textDocument, range, change.text)
                | None -> replace (doc.textDocument, change.text)

    /// 基于文件路径字符串获取文本（避免创建 FileInfo 对象）
    member this.GetTextByPath(filePath: string) : string option =
        let found, value = activeDocuments.TryGetValue(filePath)
        if found then Some(getCachedText value) else None

    member this.GetText(file: FileInfo) : string option =
        this.GetTextByPath(file.FullName)

    member this.GetVersion(file: FileInfo) : int option =
        let found, value = activeDocuments.TryGetValue(file.FullName)
        if found then Some(value.version) else None

    /// 基于文件路径字符串获取版本号
    member this.GetVersionByPath(filePath: string) : int option =
        let found, value = activeDocuments.TryGetValue(filePath)
        if found then Some(value.version) else None

    member this.Get(file: FileInfo) : option<string * int> =
        let found, value = activeDocuments.TryGetValue(file.FullName)

        if found then
            Some(getCachedText value, value.version)
        else
            None

    member this.Close(doc: DidCloseTextDocumentParams) : unit =
        let file = FileInfo(doc.textDocument.uri.LocalPath)
        activeDocuments.Remove(file.FullName) |> ignore

    member this.OpenFiles() : FileInfo list =
        [ for file in activeDocuments.Keys do
              yield FileInfo(file) ]
    
    /// 清理不存在文件的孤儿文档，防止内存泄漏
    member this.CleanupOrphanedDocuments(existingFiles: Set<string>) : unit =
        let orphanedFiles =
            activeDocuments.Keys
            |> Seq.filter (fun filePath -> not (existingFiles.Contains filePath))
            |> Seq.toList
        
        for filePath in orphanedFiles do
            activeDocuments.Remove(filePath) |> ignore
        
        if orphanedFiles.Length > 0 then
            dprintfn $"Cleaned up %i{orphanedFiles.Length} orphaned documents"

    member this.GetTextAtPosition(fileUri: Uri, position: Position) : string =
        match this.GetTextByPath(FileInfo(fileUri.LocalPath).FullName) with
        | Some(text) -> DocumentStoreHelper.GetTextAtPosition(text, position.line, position.character)
        | None -> String.Empty
