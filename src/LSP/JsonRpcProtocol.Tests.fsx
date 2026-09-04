#r "../../artifacts/bin/Main/debug/FSharp.Data.dll"
#r "../../artifacts/bin/Main/debug/CWTools.dll"
#r "../../artifacts/bin/LSP/debug/LSP.dll"
#load "../TestHelpers.fsx"

open System
open System.IO
open System.Text
open FSharp.Data
open LSP
open LSP.Types
open LSP.Json.Ser
open LSP.Tokenizer
open LSP.Parser
open TestHelpers

printfn "=== Running JsonRpcProtocol (Tokenizer, Ser, Parser) Tests ==="

let harness = TestHarness("JsonRpcProtocol")

// ============================================================================
// 1. Tokenizer (Frame Splitting, UTF-8 Multi-byte, Half-pack, Sticky-pack)
let tokenizeBytes (bytes: byte[]) =
    use ms = new MemoryStream(bytes)
    use reader = new BinaryReader(ms, Encoding.UTF8)
    tokenize reader |> Seq.toList

// Case 1.1: UTF-8 Multi-byte Characters (Chinese, Emoji, Accents)
let unicodeBody = "{\"jsonrpc\":\"2.0\",\"method\":\"test\",\"params\":{\"text\":\"你好，世界！🚀 CWTools 群星模组\"}}"
let unicodeBytes = Encoding.UTF8.GetBytes(unicodeBody)
let header = sprintf "Content-Length: %d\r\n\r\n" unicodeBytes.Length
let fullMessageBytes = Array.append (Encoding.UTF8.GetBytes(header)) unicodeBytes

let tokenizedFrames = tokenizeBytes fullMessageBytes
harness.Equal "Tokenizer frame count for single message" 1 tokenizedFrames.Length
harness.Equal "Tokenizer body matches multi-byte UTF-8 string" unicodeBody tokenizedFrames.[0]

// Case 1.2: Sticky-pack (Two complete messages packed into single stream)
let msg1 = "{\"id\":1,\"method\":\"msg1\"}"
let msg2 = "{\"id\":2,\"method\":\"msg2\"}"
let bytes1 = Encoding.UTF8.GetBytes(msg1)
let bytes2 = Encoding.UTF8.GetBytes(msg2)
let frame1 = Array.append (Encoding.UTF8.GetBytes(sprintf "Content-Length: %d\r\n\r\n" bytes1.Length)) bytes1
let frame2 = Array.append (Encoding.UTF8.GetBytes(sprintf "Content-Length: %d\r\n\r\n" bytes2.Length)) bytes2
let stickyBytes = Array.append frame1 frame2

let stickyResults = tokenizeBytes stickyBytes
harness.Equal "Tokenizer splits sticky-pack into 2 frames" 2 stickyResults.Length
harness.Equal "First sticky message matches msg1" msg1 stickyResults.[0]
harness.Equal "Second sticky message matches msg2" msg2 stickyResults.[1]

// Case 1.3: Malformed Header (Missing Content-Length)
let malformedHeader = "Invalid-Header: 123\r\n\r\nSome body"
let malformedResults = tokenizeBytes (Encoding.UTF8.GetBytes(malformedHeader))
harness.Equal "Malformed headers yield 0 frames" 0 malformedResults.Length

// ============================================================================
// 2. Ser (Serialization Factory, Reflection Smoke, Escaping, and Recursion)
// ============================================================================

let writeOptions: JsonWriteOptions =
    { customWriters =
        [ writeDiagnosticSeverity
          writeInsertTextFormat
          writeCompletionItemKind
          writeDocumentHighlightKind
          writeSymbolKind
          writeMessageType
          writeMarkupKind
          writeHoverContent
          writeTextDocumentSyncKind ] }

// Case 2.1: CRITICAL P0 SMOKE TEST
// serializerFactory<InitializeResult> MUST succeed without throwing TypeInitializationException
let initResultSerializer =
    try
        serializerFactory<InitializeResult> writeOptions
    with ex ->
        failwithf "P0 REGRESSION: serializerFactory<InitializeResult> failed during reflection: %s" ex.Message

let sampleInitResult: InitializeResult =
    { capabilities =
        { defaultServerCapabilities with
            textDocumentSync = { defaultTextDocumentSyncOptions with change = TextDocumentSyncKind.Incremental }
            hoverProvider = true
            completionProvider = Some { resolveProvider = true; triggerCharacters = [ "."; "@" ] } } }

let serializedInit = initResultSerializer sampleInitResult
harness.Check "Serialized InitializeResult contains capabilities" (serializedInit.Contains("\"capabilities\""))
harness.Check "TextDocumentSyncKind.Incremental serializes to 2 via custom writer" (serializedInit.Contains("\"change\":2"))

// Case 2.2: Basic LSP structures serialization
let posSerializer = serializerFactory<Position> writeOptions
let samplePos: Position = { line = 12; character = 34 }
harness.Equal "Position serialization format" "{\"line\":12,\"character\":34}" (posSerializer samplePos)

let rangeSerializer = serializerFactory<Range> writeOptions
let sampleRange: Range = { start = { line = 1; character = 2 }; ``end`` = { line = 3; character = 4 } }
let serializedRange = rangeSerializer sampleRange
harness.Check "Range start serializes correctly" (serializedRange.Contains("\"start\":{\"line\":1,\"character\":2}"))

// Case 2.3: Special Character Escaping (Quotes, Backslashes, Newlines)
let specialString = "Hello \"World\"\nLine 2\tTabbed \\ Backslash"
let itemSerializer = serializerFactory<CompletionItem> writeOptions
let item: CompletionItem =
    { defaultCompletionItem with
        label = specialString
        detail = Some "Details with \"quotes\"" }
let serializedItem = itemSerializer item
harness.Check "Quotes are escaped" (serializedItem.Contains("\\\"World\\\""))
harness.Check "Newlines are escaped" (serializedItem.Contains("\\n"))
harness.Check "Backslashes are escaped" (serializedItem.Contains("\\\\"))

// ============================================================================
// 3. Parser (JSON-RPC Protocol Message Parsing)
// ============================================================================

// Case 3.1: Standard Request Parsing and parseRequest dispatch
let initRawJson = "{\"jsonrpc\":\"2.0\",\"id\":100,\"method\":\"initialize\",\"params\":{\"processId\":1234,\"rootUri\":null,\"capabilities\":{}}}"
match parseMessage initRawJson with
| RequestMessage(100, "initialize", json) ->
    match parseRequest ("initialize", json) with
    | Initialize paramsVal ->
        harness.Equal "Parsed processId" (Some 1234) paramsVal.processId
    | otherReq ->
        harness.Fail("Expected Initialize request", sprintf "%A" otherReq)
| other ->
    harness.Fail("Expected RequestMessage with initialize", sprintf "%A" other)

// Case 3.2: Cancel Request Notification
let cancelJson = "{\"jsonrpc\":\"2.0\",\"method\":\"$/cancelRequest\",\"params\":{\"id\":100}}"
match parseMessage cancelJson with
| NotificationMessage("$/cancelRequest", Some json) ->
    harness.Check "Cancel payload contains request id" (json.ToString().Contains("100"))
| other ->
    harness.Fail("Expected cancel notification", sprintf "%A" other)

// Case 3.3: Client Response (Success and Error)
let successResponseJson = "{\"jsonrpc\":\"2.0\",\"id\":42,\"result\":{\"applied\":true}}"
match parseMessage successResponseJson with
| ResponseMessage(42, res) ->
    harness.Check "Parsed success response result" (res.ToString().Contains("true"))
| other ->
    harness.Fail("Expected ResponseMessage", sprintf "%A" other)

let errResponseJson = "{\"jsonrpc\":\"2.0\",\"id\":42,\"error\":{\"code\":-32600,\"message\":\"Invalid Request\"}}"
match parseMessage errResponseJson with
| ResponseMessage(42, res) ->
    harness.Equal "Error response is mapped to Null response value" JsonValue.Null res
| other ->
    harness.Fail("Expected ResponseMessage with null result", sprintf "%A" other)

// Case 3.4: Notification Parsing and parseNotification dispatch
let didOpenRawJson = "{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/didOpen\",\"params\":{\"textDocument\":{\"uri\":\"file:///test.txt\",\"languageId\":\"stellaris\",\"version\":1,\"text\":\"foo\"}}}"
match parseMessage didOpenRawJson with
| NotificationMessage("textDocument/didOpen", Some json) ->
    match parseNotification ("textDocument/didOpen", Some json) with
    | DidOpenTextDocument p ->
        harness.Equal "Parsed didOpen languageId" "stellaris" p.textDocument.languageId
        harness.Equal "Parsed didOpen version" 1 p.textDocument.version
    | otherNotif ->
        harness.Fail("Expected DidOpenTextDocument notification", sprintf "%A" otherNotif)
| other ->
    harness.Fail("Expected NotificationMessage", sprintf "%A" other)

// Case 3.5: Malformed JSON Toleration
let malformedJson = "{ broken json"
let caught =
    try
        let _ = parseMessage malformedJson
        false
    with _ ->
        true
harness.Check "Malformed JSON must throw exception or be caught" caught

harness.Summary()
