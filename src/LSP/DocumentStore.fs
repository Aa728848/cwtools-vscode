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
      mutable cachedVersion: int
      // 行偏移缓存：lineOffsets.[i] = index of first char on line i
      // Rebuilt lazily after Open/Replace; invalidated after Patch.
      mutable lineOffsets: int[] | null
      mutable lineOffsetsDirty: bool }

module DocumentStoreUtils =
    /// Build a sorted array of char offsets for the start of each line.
    /// lineOffsets.[0] = 0 always; lineOffsets.[i] = offset of first char on line i.
    let buildLineOffsets (text: StringBuilder) : int[] =
        // Pre-scan to count newlines so we can allocate exactly once
        let mutable nlCount = 0
        for i = 0 to text.Length - 1 do
            if text.[i] = '\n' then nlCount <- nlCount + 1
        let offsets = Array.zeroCreate (nlCount + 1)
        offsets.[0] <- 0
        let mutable lineIdx = 0
        for i = 0 to text.Length - 1 do
            if text.[i] = '\n' && lineIdx < nlCount then
                lineIdx <- lineIdx + 1
                offsets.[lineIdx] <- i + 1
        offsets

    /// O(log n) replacement for the old O(n) findRange.
    /// Uses a pre-built lineOffsets cache to jump directly to the right line,
    /// then walks within that line for the column offset.
    let findRangeFast (text: StringBuilder, lineOffsets: int[], range: Range) : struct (int * int) =
        let lineStart (line: int) =
            if line < lineOffsets.Length then lineOffsets.[line]
            else text.Length  // clamp past-end lines

        let posToOffset (line: int) (col: int) =
            let ls = lineStart line
            min (ls + col) text.Length

        let startOffset = posToOffset range.start.line range.start.character
        let endOffset   = posToOffset range.``end``.line range.``end``.character
        struct (startOffset, endOffset)

    /// Legacy O(n) fallback — kept for correctness validation only.
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

    /// Get line-offset cache, rebuilding if dirty.
    let getLineOffsets (v: Version) =
        if v.lineOffsetsDirty || v.lineOffsets = null then
            let offsets = buildLineOffsets v.text
            v.lineOffsets <- offsets
            v.lineOffsetsDirty <- false
            offsets
        else
            v.lineOffsets

    /// Replace a section of an open file
    let patch (doc: VersionedTextDocumentIdentifier, range: Range, text: string) : unit =
        let file = FileInfo(doc.uri.LocalPath)
        let existing = activeDocuments[file.FullName]
        // Use cached offsets for fast lookup; mark dirty after mutation.
        let offsets = getLineOffsets existing
        let struct (startOffset, endOffset) = findRangeFast (existing.text, offsets, range)
        existing.text.Remove(startOffset, endOffset - startOffset) |> ignore
        existing.text.Insert(startOffset, text) |> ignore
        existing.version <- doc.version
        // Invalidate cache — next patch/query will rebuild
        existing.lineOffsetsDirty <- true

    /// Replace the entire contents of an open file
    let replace (doc: VersionedTextDocumentIdentifier, text: string) : unit =
        let file = FileInfo(doc.uri.LocalPath)
        let existing = activeDocuments[file.FullName]
        existing.text.Clear() |> ignore
        existing.text.Append(text) |> ignore
        existing.version <- doc.version
        // Full replace: rebuild offsets eagerly (avoids lazy-rebuild on next call)
        existing.lineOffsets <- buildLineOffsets existing.text
        existing.lineOffsetsDirty <- false

    member this.Open(doc: DidOpenTextDocumentParams) : unit =
        let file = FileInfo(doc.textDocument.uri.LocalPath)
        let text = StringBuilder(doc.textDocument.text)
        let offsets = buildLineOffsets text

        let version =
            { text = text
              version = doc.textDocument.version
              cachedText = doc.textDocument.text
              cachedVersion = doc.textDocument.version
              lineOffsets = offsets
              lineOffsetsDirty = false }

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
