module LSP.LanguageServer

open LSP.Log
open System
open System.Threading
open System.Diagnostics
open System.IO
open System.Text
open FSharp.Data
open Types
open LSP.Json.Ser
open JsonExtensions
open LSP.Locking

let gameStateLock = new ReaderWriterLockSlim()
let mutable completionLockTimeoutMs = 80
let private editorRequestLockTimeoutMs = 500
let mutable completionImmediateFallback: (CompletionParams -> CompletionList option) option = None
let mutable completionTimeoutFallback: (CompletionParams -> CompletionList option) option = None

// Track writers independently of ReaderWriterLockSlim.IsWriteLockHeld, which
// only reports ownership for the calling thread. The reader thread uses this
// process-wide state to decide whether completion must return a stale fallback
// before dispatching work to the thread pool.
let mutable private gameStateWriterActivityCount = 0
let mutable private gameStateWriterActiveCount = 0

let enterGameStateWriteLock () =
    Interlocked.Increment(&gameStateWriterActivityCount) |> ignore
    try
        gameStateLock.EnterWriteLock()
        Interlocked.Increment(&gameStateWriterActiveCount) |> ignore
    with _ ->
        Interlocked.Decrement(&gameStateWriterActivityCount) |> ignore
        reraise ()

let exitGameStateWriteLock () =
    try
        gameStateLock.ExitWriteLock()
    finally
        Interlocked.Decrement(&gameStateWriterActiveCount) |> ignore
        Interlocked.Decrement(&gameStateWriterActivityCount) |> ignore

let isGameStateWriteBusy () = Volatile.Read(&gameStateWriterActivityCount) > 0

// Phase 0 observability: per-request segment tracing so a single slow request
// can be attributed to queueing, lock wait, or method execution.
let private traceLogThresholdMs = 500.0
let private traceQueueDepthThreshold = 10
let private traceLockWaitThresholdMs = 100.0

type private RequestTrace =
    { method: string
      receivedAt: int64
      mutable queueAddAt: int64
      mutable dequeuedAt: int64 option
      mutable workerStartAt: int64 option
      mutable lockWaitEndAt: int64 option
      mutable lockAcquired: bool option
      mutable methodStartAt: int64 option
      mutable methodEndAt: int64 option
      mutable responseSentAt: int64 option
      mutable lockKind: string option
      mutable outcome: string
      mutable queueDepth: int
      mutable pendingCount: int }

let private requestTraces =
    System.Collections.Concurrent.ConcurrentDictionary<int, RequestTrace>()

let private timestamp () = Stopwatch.GetTimestamp()

let private elapsedMs (start: int64) (finish: int64) =
    Stopwatch.GetElapsedTime(start, finish).TotalMilliseconds

let private segmentMs startAt endAt =
    match startAt, endAt with
    | Some startTime, Some endTime when endTime >= startTime -> elapsedMs startTime endTime
    | _ -> 0.0

let private runtimeSnapshot () =
    let mutable worker = 0
    let mutable io = 0
    let mutable maxWorker = 0
    let mutable maxIo = 0
    let mutable availWorker = 0
    let mutable availIo = 0
    let mutable minWorker = 0
    let mutable minIo = 0
    ThreadPool.GetMaxThreads(&maxWorker, &maxIo)
    ThreadPool.GetAvailableThreads(&availWorker, &availIo)
    ThreadPool.GetMinThreads(&minWorker, &minIo)
    {| workerThreads = maxWorker - availWorker
       maxWorkerThreads = maxWorker
       minWorkerThreads = minWorker
       availableWorkerThreads = max 0 availWorker
       pendingWorkItems = ThreadPool.PendingWorkItemCount
       ioThreads = maxIo - availIo
       maxIoThreads = maxIo
       readerCount = gameStateLock.CurrentReadCount
       waitingReadCount = gameStateLock.WaitingReadCount
       waitingWriteCount = gameStateLock.WaitingWriteCount
       writerActivityCount = Volatile.Read(&gameStateWriterActivityCount)
       writerActiveCount = Volatile.Read(&gameStateWriterActiveCount) |}

let private heartbeatGapThresholdMs = 500.0
let mutable private lastHeartbeatAt = timestamp ()

let private jsonWriteOptions =
    { defaultJsonWriteOptions with
        customWriters =
            [ writeTextDocumentSaveReason
              writeFileChangeType
              writeTextDocumentSyncKind
              writeDiagnosticSeverity
              writeTrace
              writeInsertTextFormat
              writeCompletionItemKind
              writeMarkedString
              writeDocumentHighlightKind
              writeSymbolKind
              writeRegisterCapability
              writeMessageType
              writeMarkupKind
              writeHoverContent ] }

let private serializeInitializeResult =
    serializerFactory<InitializeResult> jsonWriteOptions

let private serializeTextEditList =
    serializerFactory<TextEdit list> jsonWriteOptions

let private serializeCompletionList =
    serializerFactory<CompletionList> jsonWriteOptions

let private serializeCompletionListOption = Option.map serializeCompletionList
let private serializeHover = serializerFactory<Hover> jsonWriteOptions
let private serializeHoverOption = Option.map serializeHover

let private serializeCompletionItem =
    serializerFactory<CompletionItem> jsonWriteOptions

let private serializeSignatureHelp =
    serializerFactory<SignatureHelp> jsonWriteOptions

let private serializeSignatureHelpOption = Option.map serializeSignatureHelp

let private serializeLocationList =
    serializerFactory<Location list> jsonWriteOptions

let private serializeDocumentHighlightList =
    serializerFactory<DocumentHighlight list> jsonWriteOptions

let private serializeSymbolInformationList =
    serializerFactory<SymbolInformation list> jsonWriteOptions

let private serializeDocumentSymbolList =
    serializerFactory<DocumentSymbol list> jsonWriteOptions

let private serializeCommandList = serializerFactory<Command list> jsonWriteOptions

let private serializeCodeLensList =
    serializerFactory<CodeLens list> jsonWriteOptions

let private serializeCodeLens = serializerFactory<CodeLens> jsonWriteOptions

let private serializeInlayHintList =
    serializerFactory<InlayHint list> jsonWriteOptions

let private serializeDocumentLinkList =
    serializerFactory<DocumentLink list> jsonWriteOptions

let private serializeDocumentLink = serializerFactory<DocumentLink> jsonWriteOptions

let private serializeWorkspaceEdit =
    serializerFactory<WorkspaceEdit> jsonWriteOptions

let private serializePrepareRenameResult =
    serializerFactory<PrepareRenameResult> jsonWriteOptions

let private serializePrepareRenameResultOption =
    Option.map serializePrepareRenameResult

let private serializeSemanticTokens =
    serializerFactory<SemanticTokens> jsonWriteOptions

let private serializeSemanticTokensOption = Option.map serializeSemanticTokens

let private serializeSemanticTokensDelta =
    serializerFactory<SemanticTokensDelta> jsonWriteOptions

let private serializeSemanticTokensOrDelta (c: Choice<SemanticTokens, SemanticTokensDelta>) : string =
    match c with
    | Choice1Of2 t -> serializeSemanticTokens t
    | Choice2Of2 d -> serializeSemanticTokensDelta d

let private serializeSemanticTokensOrDeltaOption =
    Option.map serializeSemanticTokensOrDelta

let private serializeFoldingRangeList = serializerFactory<FoldingRange list> jsonWriteOptions
let private serializeSelectionRangeList = serializerFactory<SelectionRange list> jsonWriteOptions
let private serializeCallHierarchyItemList = serializerFactory<CallHierarchyItem list> jsonWriteOptions
let private serializeCallHierarchyIncomingCallList = serializerFactory<CallHierarchyIncomingCall list> jsonWriteOptions
let private serializeCallHierarchyOutgoingCallList = serializerFactory<CallHierarchyOutgoingCall list> jsonWriteOptions

let private serializePublishDiagnostics =
    serializerFactory<PublishDiagnosticsParams> jsonWriteOptions

let private serializeShowMessage =
    serializerFactory<ShowMessageParams> jsonWriteOptions

let private serializeRegistrationParams =
    serializerFactory<RegistrationParams> jsonWriteOptions

let private serializeLoadingBarParams =
    serializerFactory<LoadingBarParams> jsonWriteOptions

let private serializeGetWordRangeAtPosition =
    serializerFactory<GetWordRangeAtPositionParams> jsonWriteOptions

let private serializeApplyWorkspaceEdit =
    serializerFactory<ApplyWorkspaceEditParams> jsonWriteOptions

let private serializeCreateVirtualFileParams =
    serializerFactory<CreateVirtualFileParams> jsonWriteOptions

let private serializeLogMessageParams =
    serializerFactory<LogMessageParams> jsonWriteOptions

let private serializeExecuteCommandResponse =
    serializerFactory<ExecuteCommandResponse> jsonWriteOptions

let private serializeExecuteCommandResponseOption =
    Option.map serializeExecuteCommandResponse

let private serializeShutdownResponse =
    serializerFactory<int option> jsonWriteOptions

type msg =
    | Request of int * AsyncReplyChannel<JsonValue>
    | Response of int * JsonValue
    | Expire of int  // clean up timed-out pending requests

/// Monotonically increasing request ID - safe under concurrent calls.
let private requestIdCounter = ref 0
let private nextRequestId () = System.Threading.Interlocked.Increment(requestIdCounter)

/// Pending-request timeout (ms). If the client doesn't respond within this,
/// we drop the channel to prevent the Map from growing without bound.
let private requestTimeoutMs = 30_000

let responseAgent =
    MailboxProcessor.Start(fun agent ->
        let rec loop (state: Map<int, AsyncReplyChannel<JsonValue>>) =
            async {
                let! msg = agent.Receive()

                match msg with
                | Request(id, reply) ->
                    // Schedule an expiry message so stale channels get cleaned up.
                    Async.Start(
                        async {
                            do! Async.Sleep requestTimeoutMs
                            agent.Post(Expire id)
                        })
                    return! loop (state |> Map.add id reply)
                | Response(id, value) ->
                    match state |> Map.tryFind id with
                    | Some reply -> reply.Reply(value)
                    | None -> eprintfn $"Unexpected response %i{id}"
                    return! loop (state |> Map.remove id)
                | Expire id ->
                    // If the entry is still present the client never replied - silently drop it.
                    return! loop (state |> Map.remove id)
            }

        loop Map.empty)

let monitor = Lock()

let private writeClient (client: BinaryWriter, messageText: string) =
    let messageBytes = Encoding.UTF8.GetBytes(messageText)
    let headerText = $"Content-Length: %d{messageBytes.Length}\r\n\r\n"
    let headerBytes = Encoding.UTF8.GetBytes(headerText)

    monitor.Enter()

    try
        client.Write(headerBytes)
        client.Write(messageBytes)
    finally
        monitor.Exit()

let respond (client: BinaryWriter, requestId: int, jsonText: string) =
    let messageText = $"""{{"id":%d{requestId},"result":%s{jsonText}}}"""
    writeClient (client, messageText)

let private notifyClient (client: BinaryWriter, method: string, jsonText: string) =
    let messageText = $"""{{"method":"%s{method}","params":%s{jsonText}}}"""
    writeClient (client, messageText)

let private requestClient (client: BinaryWriter, id: int, method: string, jsonText: string) =
    async {
        let reply =
            responseAgent.PostAndAsyncReply(fun replyChannel -> Request(id, replyChannel))

        let messageText =
            $"""{{"id":%d{id},"method":"%s{method}", "params":%s{jsonText}}}"""

        writeClient (client, messageText)
        return! reply
    }

let private monitorLog send category message =
    try
        let json =
            JsonValue.Record
                [| "category", JsonValue.String category
                   "message", JsonValue.String message
                   "timestamp", JsonValue.String(DateTime.Now.ToString("HH:mm:ss")) |]

        notifyClient (send, "monitorLog", json.ToString(JsonSaveOptions.DisableFormatting))
    with _ -> ()

let private logRequestTrace send id (trace: RequestTrace) =
    let finish = trace.responseSentAt |> Option.defaultWith timestamp
    let totalMs = elapsedMs trace.receivedAt finish
    let queueMs = elapsedMs trace.receivedAt trace.queueAddAt
    let processQueueMs = segmentMs (Some trace.queueAddAt) trace.dequeuedAt
    let workerWaitMs = segmentMs trace.dequeuedAt trace.workerStartAt
    let lockWaitMs = segmentMs trace.workerStartAt trace.lockWaitEndAt
    let methodMs = segmentMs trace.methodStartAt trace.methodEndAt
    let responseMs = segmentMs trace.methodEndAt trace.responseSentAt

    let shouldLog =
        totalMs >= traceLogThresholdMs
        || trace.queueDepth >= traceQueueDepthThreshold
        || lockWaitMs >= traceLockWaitThresholdMs
        || trace.outcome <> "success"

    if shouldLog then
        let snapshot = runtimeSnapshot ()

        let payload =
            JsonValue.Record
                [| "id", JsonValue.Number(decimal id)
                   "method", JsonValue.String trace.method
                   "totalMs", JsonValue.Number(decimal totalMs)
                   "queueMs", JsonValue.Number(decimal queueMs)
                   "processQueueMs", JsonValue.Number(decimal processQueueMs)
                   "workerWaitMs", JsonValue.Number(decimal workerWaitMs)
                   "lockWaitMs", JsonValue.Number(decimal lockWaitMs)
                   "methodMs", JsonValue.Number(decimal methodMs)
                   "responseMs", JsonValue.Number(decimal responseMs)
                   "lockKind", JsonValue.String(trace.lockKind |> Option.defaultValue "none")
                   "lockAcquired",
                        (match trace.lockAcquired with
                         | Some value -> JsonValue.Boolean value
                         | None -> JsonValue.Null)
                   "outcome", JsonValue.String trace.outcome
                   "queueDepth", JsonValue.Number(decimal trace.queueDepth)
                   "pendingCount", JsonValue.Number(decimal trace.pendingCount)
                   "workerThreads", JsonValue.Number(decimal snapshot.workerThreads)
                   "maxWorkerThreads", JsonValue.Number(decimal snapshot.maxWorkerThreads)
                   "minWorkerThreads", JsonValue.Number(decimal snapshot.minWorkerThreads)
                   "availableWorkerThreads", JsonValue.Number(decimal snapshot.availableWorkerThreads)
                   "pendingWorkItems", JsonValue.Number(decimal snapshot.pendingWorkItems)
                   "readerCount", JsonValue.Number(decimal snapshot.readerCount)
                   "waitingReadCount", JsonValue.Number(decimal snapshot.waitingReadCount)
                   "waitingWriteCount", JsonValue.Number(decimal snapshot.waitingWriteCount)
                   "writerActivityCount", JsonValue.Number(decimal snapshot.writerActivityCount)
                   "writerActiveCount", JsonValue.Number(decimal snapshot.writerActiveCount) |]

        monitorLog send "RequestTrace" (payload.ToString(JsonSaveOptions.DisableFormatting))

let private finishRequestTrace (send: BinaryWriter) (id: int) (outcome: string) =
    match requestTraces.TryRemove id with
    | true, trace ->
        trace.outcome <- outcome
        if trace.responseSentAt.IsNone then trace.responseSentAt <- Some(timestamp ())
        logRequestTrace send id trace
    | _ -> ()

let private startHeartbeatThread (send: BinaryWriter) =
    let thread =
        Thread(fun () ->
            while true do
                Thread.Sleep 100
                let now = timestamp ()
                let gap = elapsedMs lastHeartbeatAt now
                lastHeartbeatAt <- now
                if gap > heartbeatGapThresholdMs then
                    let snapshot = runtimeSnapshot ()
                    monitorLog send "Heartbeat"
                        $"heartbeatGapMs={gap} pendingWorkItems={snapshot.pendingWorkItems} availableWorkers={snapshot.availableWorkerThreads} writerActive={snapshot.writerActiveCount} waitingWriters={snapshot.waitingWriteCount}")

    thread.IsBackground <- true
    thread.Start()

let private thenMap (f: 'A -> 'B) (result: Async<'A>) : Async<'B> =
    async {
        let! a = result
        return f a
    }

let private thenSome = thenMap Some
let private thenNone (result: Async<'A>) : Async<string option> = result |> thenMap (fun _ -> None)

let private notExit (message: Parser.Message) =
    match message with
    | Parser.NotificationMessage("exit", _) -> false
    | _ -> true

let readMessages (receive: BinaryReader) : seq<Parser.Message> =
    let tokens = Tokenizer.tokenize receive
    let parse = Seq.map Parser.parseMessage tokens
    Seq.takeWhile notExit parse

type RealClient(send: BinaryWriter) =
    interface ILanguageClient with
        member this.LogMessage(p: LogMessageParams) : unit =
            let json = serializeLogMessageParams p
            notifyClient (send, "window/logMessage", json)

        member this.PublishDiagnostics(p: PublishDiagnosticsParams) : unit =
            let json = serializePublishDiagnostics p
            notifyClient (send, "textDocument/publishDiagnostics", json)

        member this.ShowMessage(p: ShowMessageParams) : unit =
            let json = serializeShowMessage p
            notifyClient (send, "window/showMessage", json)

        member this.RegisterCapability(p: RegisterCapability) : unit =
            match p with
            | RegisterCapability.DidChangeWatchedFiles _ ->
                let register =
                    { id = Guid.NewGuid().ToString()
                      method = "workspace/didChangeWatchedFiles"
                      registerOptions = p }

                let message = { registrations = [ register ] }
                let json = serializeRegistrationParams message
                notifyClient (send, "client/registerCapability", json)

        member this.CustomNotification(method: string, json: JsonValue) : unit =
            let jsonString = json.ToString(JsonSaveOptions.DisableFormatting)
            notifyClient (send, method, jsonString)

        member this.ApplyWorkspaceEdit(p: ApplyWorkspaceEditParams) : Async<JsonValue> =
            async {
                let json = serializeApplyWorkspaceEdit p
                let id = nextRequestId ()
                return! requestClient (send, id, "workspace/applyEdit", json)
            }

        member this.CustomRequest(method: string, json: string) : Async<JsonValue> =
            async {
                let id = nextRequestId ()
                return! requestClient (send, id, method, json)
            }


type private ReadLockFallback =
    { timeoutMs: int
      getResult: unit -> string option }

type private PendingTask =
    | ProcessNotification of method: string * task: Async<unit> * needsWriteLock: bool
    | ProcessLockFreeRequest of id: int * task: Async<string option> * cancel: CancellationTokenSource
    | ProcessRequest of
        id: int *
        task: Async<string option> *
        cancel: CancellationTokenSource *
        isReadOnly: bool *
        lockFallback: ReadLockFallback option
    | Quit

let connect (serverFactory: ILanguageClient -> ILanguageServer, receive: BinaryReader, send: BinaryWriter) =
    startHeartbeatThread send
    let server = serverFactory (RealClient(send))

    /// Returns (serialisedResponseTask, isReadOnly).
    /// isReadOnly = true  -> safe to run concurrently with other reads, holding gameStateLock in read mode.
    /// isReadOnly = false -> must run exclusively, holding gameStateLock in write mode.
    let processRequest (request: Request) : Async<string option> * bool =
        match request with
        | Initialize(p)         -> server.Initialize(p) |> thenMap serializeInitializeResult |> thenSome, false
        | Shutdown              -> server.Shutdown()     |> thenMap serializeShutdownResponse |> thenSome, false
        | WillSaveWaitUntilTextDocument(p) ->
            server.WillSaveWaitUntilTextDocument(p) |> thenMap serializeTextEditList |> thenSome, false
        // - Read-only requests (concurrent execution) -
        | Completion(p)         -> server.Completion(p)          |> thenMap serializeCompletionListOption,               true
        | Hover(p)              -> server.Hover(p)               |> thenMap serializeHoverOption |> thenMap (Option.defaultValue "null") |> thenSome, true
        | ResolveCompletionItem(p) -> server.ResolveCompletionItem(p) |> thenMap serializeCompletionItem |> thenSome,    true
        | SignatureHelp(p)      -> server.SignatureHelp(p)        |> thenMap serializeSignatureHelpOption |> thenMap (Option.defaultValue "null") |> thenSome, true
        | GotoDefinition(p)     -> server.GotoDefinition(p)      |> thenMap serializeLocationList |> thenSome,           true
        | FindReferences(p)     -> server.FindReferences(p)      |> thenMap serializeLocationList |> thenSome,           true
        | DocumentHighlight(p)  -> server.DocumentHighlight(p)   |> thenMap serializeDocumentHighlightList |> thenSome,  true
        | DocumentSymbols(p)    -> server.DocumentSymbols(p)     |> thenMap serializeDocumentSymbolList |> thenSome,     true
        | WorkspaceSymbols(p)   -> server.WorkspaceSymbols(p)    |> thenMap serializeSymbolInformationList |> thenSome,  true
        | CodeLens(p)           -> server.CodeLens(p)            |> thenMap serializeCodeLensList |> thenSome,           true
        | ResolveCodeLens(p)    -> server.ResolveCodeLens(p)     |> thenMap serializeCodeLens |> thenSome,               true
        | InlayHint(p)          -> server.InlayHint(p)           |> thenMap serializeInlayHintList |> thenSome,          true
        | DocumentLink(p)       -> server.DocumentLink(p)        |> thenMap serializeDocumentLinkList |> thenSome,       true
        | ResolveDocumentLink(p)-> server.ResolveDocumentLink(p) |> thenMap serializeDocumentLink |> thenSome,           true
        | SemanticTokensFull(p) -> server.SemanticTokensFull(p)  |> thenMap serializeSemanticTokensOption |> thenMap (Option.defaultValue "[[CANCEL]]") |> thenSome, true
        | SemanticTokensFullDelta(p) -> server.SemanticTokensFullDelta(p) |> thenMap serializeSemanticTokensOrDeltaOption |> thenMap (Option.defaultValue "[[CANCEL]]") |> thenSome, true
        | FoldingRanges(p)      -> server.FoldingRanges(p)       |> thenMap serializeFoldingRangeList |> thenSome, true
        | SelectionRanges(p)    -> server.SelectionRanges(p)     |> thenMap serializeSelectionRangeList |> thenSome, true
        | PrepareCallHierarchy(p) -> server.PrepareCallHierarchy(p) |> thenMap serializeCallHierarchyItemList |> thenSome, true
        | CallHierarchyIncomingCalls(p) -> server.CallHierarchyIncomingCalls(p) |> thenMap serializeCallHierarchyIncomingCallList |> thenSome, true
        | CallHierarchyOutgoingCalls(p) -> server.CallHierarchyOutgoingCalls(p) |> thenMap serializeCallHierarchyOutgoingCallList |> thenSome, true
        // CodeActions reads game state but result doesn't mutate; treat as read-only
        | CodeActions(p)        -> server.CodeActions(p)         |> thenMap serializeCommandList |> thenSome,            true
        // ExecuteCommand: split into read-only (query/info) and write (etc.)
        | ExecuteCommand(p) ->
            let isReadCmd =
                match p.command with
                | "cwtools.ai.getScopeAtPosition"
                | "cwtools.ai.getCompletionContext"
                | "cwtools.findTypeReferences"
                | "cwtools.ai.queryTypes"
                | "cwtools.ai.queryDefinition"
                | "cwtools.ai.queryDefinitionByName"
                | "cwtools.ai.exploreProject"
                | "cwtools.ai.exploreInlineGraph"
                | "cwtools.ai.analyzePdxFlow"
                | "cwtools.ai.queryLocalisationAudit"
                | "cwtools.ai.compareDefinitionWithVanilla"
                | "cwtools.ai.queryProjectKnowledgeDb"
                | "cwtools.ai.getSemanticCatalog"
                | "cwtools.ai.validateOverlay"
                | "cwtools.ai.queryScriptedEffects"
                | "cwtools.ai.queryScriptedTriggers"
                | "cwtools.ai.queryEnums"
                | "cwtools.ai.getEntityInfo"
                | "cwtools.ai.queryStaticModifiers"
                | "cwtools.ai.queryVariables"
                | "cwtools.ai.queryOverrideModes"
                | "cwtools.ai.getDiagnosticsFresh"
                | "cwtools.ai.getAllDiagnostics"
                | "cwtools.ai.waitDiagnosticsFresh"
                | "cwtools.ai.getValidationStatus"
                | "cwtools.ai.revalidateFiles"
                | "cwtools.ai.parseFragment"
                | "cwtools.ai.shader.symbols"
                | "cwtools.ai.shader.compileUnit"
                | "cwtools.ai.shader.variants"
                | "cwtools.ai.shader.callers"
                | "cwtools.ai.shader.reachability"
                | "cwtools.ai.shader.validate"
                | "cwtools.ai.shader.preflightEdit"
                | "cwtools.ai.shader.compareVanilla"
                | "cwtools.exportTypes"
                | "typeGraphInfo"
                | "getFileTypes"
                | "getDataForFile"
                | "getTypesForFile"  -> true
                | "cwtools.ai.exportProjectKnowledge" ->
                    p.arguments
                    |> List.tryHead
                    |> Option.bind (function
                        | JsonValue.Record fields ->
                            fields
                            |> Array.tryPick (fun (key, value) ->
                                if key = "generationMode" then
                                    match value with
                                    | JsonValue.String mode -> Some mode
                                    | _ -> None
                                else None)
                        | _ -> None)
                    |> Option.exists (fun mode -> mode = "incremental")
                | _                  -> false
            server.ExecuteCommand p |> thenMap serializeExecuteCommandResponseOption, isReadCmd


        // - Write / formatting -
        | DocumentFormatting(p)     -> server.DocumentFormatting(p)     |> thenMap serializeTextEditList |> thenSome, false
        | DocumentRangeFormatting(p)-> server.DocumentRangeFormatting(p)|> thenMap serializeTextEditList |> thenSome, false
        | DocumentOnTypeFormatting(p)->server.DocumentOnTypeFormatting(p)|> thenMap serializeTextEditList |> thenSome, false
        | PrepareRename(p)          -> server.PrepareRename(p)          |> thenMap serializePrepareRenameResultOption |> thenMap (Option.defaultValue "null") |> thenSome, true
        | Rename(p)                 -> server.Rename(p)                 |> thenMap serializeWorkspaceEdit |> thenSome, false
        | DidChangeWorkspaceFolders(p) -> server.DidChangeWorkspaceFolders(p) |> thenNone,                             false

    let processNotification (n: Notification) : Async<unit> * bool =
        match n with
        // These two mutate gameObj / start processWorkspace -> need exclusive Write Lock
        | Initialized            -> server.Initialized(), true
        | DidChangeConfiguration(p) -> server.DidChangeConfiguration(p), true
        // All others only touch DocumentStore + MailboxProcessor (both thread-safe) -> no lock needed
        | DidOpenTextDocument(p)  -> server.DidOpenTextDocument(p), false
        | DidChangeTextDocument(p)-> server.DidChangeTextDocument(p), false
        | WillSaveTextDocument(p) -> server.WillSaveTextDocument(p), false
        | DidSaveTextDocument(p)  -> server.DidSaveTextDocument(p), false
        | DidCloseTextDocument(p) -> server.DidCloseTextDocument(p), false
        | DidChangeWatchedFiles(p)-> server.DidChangeWatchedFiles(p), false
        | DidFocusFile(p)         -> server.DidFocusFile(p), false
        | OtherNotification _     -> async { () }, false
    // Read messages and process cancellations on a separate thread
    let pendingRequests =
        System.Collections.Concurrent.ConcurrentDictionary<int, CancellationTokenSource>()

    let processQueue =
        new System.Collections.Concurrent.BlockingCollection<PendingTask>()

    let fixedLockFallback timeoutMs result =
        Some
            { timeoutMs = timeoutMs
              getResult = fun () -> Some result }

    let readLoop () =
        try
            // Read all messages on the main thread
            for m in readMessages receive do
                // Process cancellations immediately
                match m with
                | Parser.NotificationMessage("$/cancelRequest", Some json) ->
                    let id = json?id.AsInteger()
                    let stillRunning, pendingRequest = pendingRequests.TryGetValue(id)

                    if stillRunning then
                        //dprintfn "Cancelling request %d" id
                        pendingRequest.Cancel()
                    else
                        ()
                //dprintfn "Request %d has already finished" id
                // Process other requests on worker thread
                | Parser.NotificationMessage(method, json) ->
                    let n = Parser.parseNotification (method, json)
                    let task, needsWriteLock = processNotification n
                    processQueue.Add(ProcessNotification(method, task, needsWriteLock))
                | Parser.RequestMessage(id, method, json) ->
                    let parsed = Parser.parseRequest (method, json)
                    let receivedAt = timestamp ()
                    let trace =
                        { method = method
                          receivedAt = receivedAt
                          queueAddAt = receivedAt
                          dequeuedAt = None
                          workerStartAt = None
                          lockWaitEndAt = None
                          lockAcquired = None
                          methodStartAt = None
                          methodEndAt = None
                          responseSentAt = None
                          lockKind = None
                          outcome = "pending"
                          queueDepth = 0
                          pendingCount = 0 }

                    requestTraces.[id] <- trace

                    let immediateFallback =
                        match parsed with
                        | Completion p ->
                            completionImmediateFallback
                            |> Option.bind (fun provider -> provider p)
                            |> serializeCompletionListOption
                        | _ -> None
                    match immediateFallback with
                    | Some result ->
                        trace.lockKind <- Some "reader-immediate-fallback"
                        trace.methodStartAt <- Some receivedAt
                        trace.methodEndAt <- Some(timestamp ())
                        respond (send, id, result)
                        trace.responseSentAt <- Some(timestamp ())
                        finishRequestTrace send id "immediate-fallback"
                    | None ->
                        let task, isReadOnly = processRequest parsed
                        // Editor-facing reads must not accumulate behind a long
                        // validation/cache writer. VS Code naturally retries its
                        // background providers; direct navigation gets a bounded
                        // empty response instead of an unbounded loading widget.
                        let lockFallback =
                            match parsed with
                            | Completion p ->
                                Some
                                    { timeoutMs = completionLockTimeoutMs
                                      getResult =
                                        fun () ->
                                            completionTimeoutFallback
                                            |> Option.bind (fun provider -> provider p)
                                            |> serializeCompletionListOption }
                            | Hover _
                            | SignatureHelp _
                            | PrepareRename _ ->
                                fixedLockFallback editorRequestLockTimeoutMs "null"
                            | GotoDefinition _
                            | FindReferences _
                            | DocumentHighlight _ ->
                                fixedLockFallback editorRequestLockTimeoutMs "[]"
                            | DocumentSymbols _
                            | WorkspaceSymbols _
                            | CodeLens _
                            | InlayHint _
                            | DocumentLink _
                            | SelectionRanges _
                            | PrepareCallHierarchy _
                            | CallHierarchyIncomingCalls _
                            | CallHierarchyOutgoingCalls _
                            | CodeActions _ ->
                                fixedLockFallback editorRequestLockTimeoutMs "[]"
                            | ResolveCompletionItem item ->
                                fixedLockFallback editorRequestLockTimeoutMs (serializeCompletionItem item)
                            | ResolveCodeLens lens ->
                                fixedLockFallback editorRequestLockTimeoutMs (serializeCodeLens lens)
                            | ResolveDocumentLink link ->
                                fixedLockFallback editorRequestLockTimeoutMs (serializeDocumentLink link)
                            | SemanticTokensFull _
                            | SemanticTokensFullDelta _ ->
                                // Never publish ranges from an older document version.
                                // A prompt cancellation keeps VS Code's shifted tokens
                                // visible and lets it retry after the writer drains.
                                fixedLockFallback completionLockTimeoutMs "[[CANCEL]]"
                            | _ -> None
                        let cancel = new CancellationTokenSource()
                        pendingRequests[id] <- cancel
                        // Publish the cancellation source before the work item. A
                        // fast worker must never finish/remove the request before
                        // the reader has made it cancellable.
                        trace.queueAddAt <- timestamp ()
                        trace.queueDepth <- processQueue.Count + 1
                        trace.pendingCount <- pendingRequests.Count
                        match parsed with
                        | FoldingRanges _ ->
                            // Folding scans only the current DocumentStore text. It
                            // must remain available while the game model has a writer.
                            processQueue.Add(ProcessLockFreeRequest(id, task, cancel))
                        | ExecuteCommand p when p.command = "cwtools.ai.getValidationStatus" ->
                            // Readiness snapshots use independently synchronized state
                            // and must remain observable while project loading has the writer.
                            processQueue.Add(ProcessLockFreeRequest(id, task, cancel))
                        | _ ->
                            processQueue.Add(ProcessRequest(id, task, cancel, isReadOnly, lockFallback))
                | Parser.ResponseMessage(id, result) -> responseAgent.Post(Response(id, result))

        with e ->
            dprintfn $"Exception in read thread {e}"

    Thread(fun () ->
        try
            readLoop ()
        finally
            // A transport exception must terminate the server just like a clean EOF.
            // Otherwise the main loop can remain blocked forever as an orphan process.
            processQueue.Add(Quit)

    )
        .Start()
    // Process messages on main thread
    let mutable quit = false

    let respondRequestCancelled id =
        let errText = $"""{{"id":%d{id},"error":{{"code":-32800,"message":"RequestCancelled"}}}}"""
        writeClient (send, errText)

    let startLockFreeRequest
        (id: int)
        (task: Async<string option>)
        (cancel: CancellationTokenSource)
        =
        let workflow =
            async {
                let mutable traceRef = None
                match requestTraces.TryGetValue id with
                | true, trace ->
                    trace.workerStartAt <- Some(timestamp ())
                    trace.lockKind <- Some "lock-free"
                    trace.lockAcquired <- Some true
                    trace.lockWaitEndAt <- trace.workerStartAt
                    traceRef <- Some trace
                | _ -> ()

                if not cancel.IsCancellationRequested then
                    traceRef |> Option.iter (fun t -> t.methodStartAt <- Some(timestamp ()))
                    try
                        match! task with
                        | Some result ->
                            respond (send, id, result)
                        | None ->
                            respond (send, id, "null")
                    finally
                        traceRef |> Option.iter (fun t -> t.methodEndAt <- Some(timestamp ()))

                    traceRef |> Option.iter (fun t -> t.responseSentAt <- Some(timestamp ()))
                    finishRequestTrace send id "success"
                else
                    finishRequestTrace send id "cancelled-before-start"

                pendingRequests.TryRemove(id) |> ignore
            }

        Async.StartWithContinuations(
            workflow,
            (fun () -> ()),
            (fun error ->
                pendingRequests.TryRemove(id) |> ignore
                finishRequestTrace send id "error"
                dprintfn $"Unhandled lock-free request failure %d{id}: %O{error}"),
            (fun _ ->
                pendingRequests.TryRemove(id) |> ignore
                respondRequestCancelled id
                finishRequestTrace send id "cancelled"),
            cancel.Token
        )

    // Helper: run a read-only task concurrently on the .NET thread pool,
    // acquiring a shared read lock so concurrent writes are properly blocked.
    let startReadOnlyRequest
        (id: int)
        (task: Async<string option>)
        (cancel: CancellationTokenSource)
        (lockFallback: ReadLockFallback option)
        =
        let run () =
            let mutable traceRef = None
            try
                try
                    match requestTraces.TryGetValue id with
                    | true, trace ->
                        trace.workerStartAt <- Some(timestamp ())
                        trace.lockKind <- (if lockFallback.IsSome then Some "read-fallback" else Some "read")
                        traceRef <- Some trace
                    | _ -> ()

                    let tracedTask =
                        async {
                            traceRef |> Option.iter (fun t -> t.methodStartAt <- Some(timestamp ()))
                            try
                                return! task
                            finally
                                traceRef |> Option.iter (fun t -> t.methodEndAt <- Some(timestamp ()))
                        }

                    let timeoutMs = lockFallback |> Option.map (fun fallback -> fallback.timeoutMs)
                    let lockResult = runReadLocked gameStateLock timeoutMs cancel.Token tracedTask
                    traceRef
                    |> Option.iter (fun t ->
                        t.lockWaitEndAt <- Some(timestamp ())
                        t.lockAcquired <- Some(match lockResult with | Acquired _ -> true | TimedOut -> false))

                    match lockResult with
                    | Acquired result when not cancel.IsCancellationRequested ->
                        match result with
                        | Some "[[CANCEL]]" -> respondRequestCancelled id
                        | Some response -> respond (send, id, response)
                        | None -> respond (send, id, "null")
                        traceRef |> Option.iter (fun t -> t.responseSentAt <- Some(timestamp ()))
                        finishRequestTrace send id "success"
                    | TimedOut when not cancel.IsCancellationRequested ->
                        traceRef |> Option.iter (fun t -> t.methodStartAt <- Some(timestamp ()))
                        try
                            match lockFallback |> Option.bind (fun fallback -> fallback.getResult ()) with
                            | Some "[[CANCEL]]" -> respondRequestCancelled id
                            | Some response -> respond (send, id, response)
                            | None -> respond (send, id, "null")
                        finally
                            traceRef |> Option.iter (fun t -> t.methodEndAt <- Some(timestamp ()))
                        traceRef |> Option.iter (fun t -> t.responseSentAt <- Some(timestamp ()))
                        finishRequestTrace send id "lock-timeout-fallback"
                    | _ ->
                        respondRequestCancelled id
                        finishRequestTrace send id "cancelled"
                with
                | :? OperationCanceledException ->
                    if requestTraces.ContainsKey id then respondRequestCancelled id
                    finishRequestTrace send id "cancelled"
                | error ->
                    // Every request must receive a terminal response. Leaving an
                    // exception unanswered makes VS Code show an endless loading UI.
                    if requestTraces.ContainsKey id then respondRequestCancelled id
                    finishRequestTrace send id "error"
                    dprintfn $"Unhandled read request failure %d{id}: %O{error}"
            finally
                pendingRequests.TryRemove(id) |> ignore

        System.Threading.Tasks.Task.Run(Action run) |> ignore

    // Helper: run a write-class task serially, acquiring an exclusive write lock.
    // Any in-flight read-only requests will finish before the lock is granted.
    let runWriteRequest (id: int) (task: Async<string option>) (cancel: CancellationTokenSource) =
        let mutable traceRef = None
        match requestTraces.TryGetValue id with
        | true, trace ->
            trace.lockKind <- Some "write"
            traceRef <- Some trace
        | _ -> ()

        if not cancel.IsCancellationRequested then
            enterGameStateWriteLock ()
            traceRef
            |> Option.iter (fun t ->
                t.lockWaitEndAt <- Some(timestamp ())
                t.lockAcquired <- Some true)
            try
                try
                    traceRef |> Option.iter (fun t -> t.methodStartAt <- Some(timestamp ()))
                    match Async.RunSynchronously(task, cancellationToken = cancel.Token) with
                    | Some result ->
                        respond (send, id, result)
                    | None        ->
                        respond (send, id, "null")
                with
                | :? OperationCanceledException ->
                    respondRequestCancelled id
                | :? System.TimeoutException    ->
                    ()   // guard: should not occur without a timeout arg, but be safe
            finally
                traceRef |> Option.iter (fun t -> t.methodEndAt <- Some(timestamp ()))
                exitGameStateWriteLock ()

            traceRef |> Option.iter (fun t -> t.responseSentAt <- Some(timestamp ()))
            finishRequestTrace send id (if cancel.IsCancellationRequested then "cancelled" else "success")
        else
            finishRequestTrace send id "cancelled-before-start"

        pendingRequests.TryRemove(id) |> ignore

    while not quit do
        match processQueue.Take() with
        | Quit -> quit <- true
        | ProcessNotification(_, task, true  (* needsWriteLock *)) ->
            enterGameStateWriteLock ()
            try
                Async.RunSynchronously(task)
            finally
                exitGameStateWriteLock ()
        | ProcessNotification(_, task, false (* no lock needed *)) ->
            Async.RunSynchronously(task)
        | ProcessLockFreeRequest(id, task, cancel) ->
            match requestTraces.TryGetValue id with
            | true, trace -> trace.dequeuedAt <- Some(timestamp ())
            | _ -> ()
            startLockFreeRequest id task cancel
        | ProcessRequest(id, task, cancel, true (* isReadOnly *), lockFallback) ->
            match requestTraces.TryGetValue id with
            | true, trace -> trace.dequeuedAt <- Some(timestamp ())
            | _ -> ()
            startReadOnlyRequest id task cancel lockFallback
        | ProcessRequest(id, task, cancel, false (* isWrite    *), _) ->
            match requestTraces.TryGetValue id with
            | true, trace ->
                let dequeuedAt = timestamp ()
                trace.dequeuedAt <- Some dequeuedAt
                trace.workerStartAt <- Some dequeuedAt
            | _ -> ()
            runWriteRequest id task cancel

    Environment.Exit(0)  // normal shutdown - allows finalizers to run
