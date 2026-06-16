module LSP.LanguageServer

open LSP.Log
open System
open System.Threading
open System.IO
open System.Text
open FSharp.Data
open Types
open LSP.Json.Ser
open JsonExtensions

let gameStateLock = new ReaderWriterLockSlim()
let mutable completionLockTimeoutMs = 300
let mutable completionTimeoutFallback: (CompletionParams -> CompletionList option) option = None

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


type private PendingTask =
    | ProcessNotification of method: string * task: Async<unit> * needsWriteLock: bool
    | ProcessRequest of
        id: int *
        task: Async<string option> *
        cancel: CancellationTokenSource *
        isReadOnly: bool *
        lockFallback: (unit -> string option) option
    | Quit

let connect (serverFactory: ILanguageClient -> ILanguageServer, receive: BinaryReader, send: BinaryWriter) =
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
                | "cwtools.ai.queryScriptedEffects"
                | "cwtools.ai.queryScriptedTriggers"
                | "cwtools.ai.queryEnums"
                | "cwtools.ai.getEntityInfo"
                | "cwtools.ai.queryStaticModifiers"
                | "cwtools.ai.queryVariables"
                | "cwtools.ai.getDiagnosticsFresh"
                | "cwtools.ai.getAllDiagnostics"
                | "cwtools.ai.waitDiagnosticsFresh"
                | "cwtools.ai.getValidationStatus"
                | "cwtools.ai.revalidateFiles"
                | "cwtools.ai.parseFragment"
                | "cwtools.exportTypes"
                | "typeGraphInfo"
                | "getFileTypes"
                | "getDataForFile"
                | "getTypesForFile"  -> true
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

    Thread(fun () ->
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
                    let task, isReadOnly = processRequest parsed
                    let lockFallback =
                        match parsed with
                        | Completion p ->
                            Some(fun () ->
                                completionTimeoutFallback
                                |> Option.bind (fun provider -> provider p)
                                |> serializeCompletionListOption)
                        | _ -> None
                    let cancel = new CancellationTokenSource()
                    processQueue.Add(ProcessRequest(id, task, cancel, isReadOnly, lockFallback))
                    pendingRequests[id] <- cancel
                | Parser.ResponseMessage(id, result) -> responseAgent.Post(Response(id, result))

            processQueue.Add(Quit)
        with e ->
            dprintfn $"Exception in read thread {e}"

    )
        .Start()
    // Process messages on main thread
    let mutable quit = false

    // Helper: run a read-only task concurrently on the .NET thread pool,
    // acquiring a shared read lock so concurrent writes are properly blocked.
    let startReadOnlyRequest
        (id: int)
        (task: Async<string option>)
        (cancel: CancellationTokenSource)
        (lockFallback: (unit -> string option) option)
        =
        Async.Start(
            async {
                let acquired =
                    match lockFallback with
                    | Some _ -> gameStateLock.TryEnterReadLock(completionLockTimeoutMs)
                    | None ->
                        gameStateLock.EnterReadLock()
                        true

                if acquired then
                    try
                        if not cancel.IsCancellationRequested then
                            try
                                match! task with
                                | Some result ->
                                    if result = "[[CANCEL]]" then
                                        let errText = $"""{{"id":%d{id},"error":{{"code":-32800,"message":"RequestCancelled"}}}}"""
                                        writeClient (send, errText)
                                    else respond (send, id, result)
                                | None        -> respond (send, id, "null")
                            with :? OperationCanceledException -> ()
                    finally
                        gameStateLock.ExitReadLock()
                        pendingRequests.TryRemove(id) |> ignore
                else
                    try
                        if not cancel.IsCancellationRequested then
                            match lockFallback |> Option.bind (fun fb -> fb ()) with
                            | Some result -> respond (send, id, result)
                            | None -> respond (send, id, "null")
                    finally
                        pendingRequests.TryRemove(id) |> ignore
            },
            cancel.Token
        )

    // Helper: run a write-class task serially, acquiring an exclusive write lock.
    // Any in-flight read-only requests will finish before the lock is granted.
    let runWriteRequest (id: int) (task: Async<string option>) (cancel: CancellationTokenSource) =
        if not cancel.IsCancellationRequested then
            gameStateLock.EnterWriteLock()
            try
                try
                    match Async.RunSynchronously(task, cancellationToken = cancel.Token) with
                    | Some result -> respond (send, id, result)
                    | None        -> respond (send, id, "null")
                with
                | :? OperationCanceledException -> ()
                | :? System.TimeoutException    -> ()   // guard: should not occur without a timeout arg, but be safe
            finally
                gameStateLock.ExitWriteLock()
        pendingRequests.TryRemove(id) |> ignore

    while not quit do
        match processQueue.Take() with
        | Quit -> quit <- true
        | ProcessNotification(_, task, true  (* needsWriteLock *)) ->
            gameStateLock.EnterWriteLock()
            try
                Async.RunSynchronously(task)
            finally
                gameStateLock.ExitWriteLock()
        | ProcessNotification(_, task, false (* no lock needed *)) ->
            Async.RunSynchronously(task)
        | ProcessRequest(id, task, cancel, true (* isReadOnly *), lockFallback) ->
            startReadOnlyRequest id task cancel lockFallback
        | ProcessRequest(id, task, cancel, false (* isWrite    *), _) ->
            runWriteRequest id task cancel

    Environment.Exit(0)  // normal shutdown - allows finalizers to run
