open System
open System.IO
open System.Threading
open System.Threading.Tasks

let check condition message =
    if not condition then failwith message

let equal expected actual message =
    if expected <> actual then
        failwithf "%s. Expected %A, got %A" message expected actual

type TypedSlot =
    | NoSlot
    | SlotA of obj
    | SlotB of obj

type Candidate =
    { Generation: int64
      Game: obj option
      Typed: TypedSlot }

type PublishedState =
    { Game: obj option
      Typed: TypedSlot }

let sameReference left right = Object.ReferenceEquals(left, right)

let coherent (candidate: Candidate) =
    match candidate.Game, candidate.Typed with
    | None, NoSlot -> true
    | Some game, SlotA typed
    | Some game, SlotB typed -> sameReference game typed
    | _ -> false

let publishIfCurrent liveGeneration (candidate: Candidate) =
    if candidate.Generation <> liveGeneration || not (coherent candidate) then None
    else Some { Game = candidate.Game; Typed = candidate.Typed }

let rootLock = new ReaderWriterLockSlim(LockRecursionPolicy.NoRecursion)
let oldGame = obj ()
let newGame = obj ()
let staleGame = obj ()
let mutable liveGeneration = 1L
let mutable published = { Game = Some oldGame; Typed = SlotA oldGame }

let snapshot () =
    rootLock.EnterReadLock()
    try published
    finally rootLock.ExitReadLock()

// Delayed detached preparation must not change globals, and readers keep seeing
// the old coherent game/typed pair while the candidate is built.
let preparationStarted = new ManualResetEventSlim(false)
let releasePreparation = new ManualResetEventSlim(false)
let delayedCandidate =
    Task.Run(fun () ->
        preparationStarted.Set()
        releasePreparation.Wait()
        { Generation = 1L; Game = Some newGame; Typed = SlotB newGame })

check (preparationStarted.Wait(1000)) "Delayed preparation must start"
let duringPreparation = snapshot ()
check (duringPreparation.Game |> Option.exists (sameReference oldGame))
      "Detached preparation must leave the published game unchanged"
match duringPreparation.Typed with
| SlotA typed -> check (sameReference oldGame typed) "Readers must retain the old typed slot"
| _ -> failwith "Readers observed the wrong typed slot during preparation"
releasePreparation.Set()
let currentCandidate = delayedCandidate.GetAwaiter().GetResult()
let beforePublish = snapshot ()
check (beforePublish.Game |> Option.exists (sameReference oldGame))
      "A completed candidate must remain detached until publication"

// Publication swaps the untyped and typed references in one root write-lock
// interval. A waiting reader can observe only the old pair or the new pair.
let writerEntered = new ManualResetEventSlim(false)
let allowWriterExit = new ManualResetEventSlim(false)
let publishTask =
    Task.Run(fun () ->
        rootLock.EnterWriteLock()
        try
            writerEntered.Set()
            match publishIfCurrent liveGeneration currentCandidate with
            | Some next -> published <- next
            | None -> failwith "Current candidate was unexpectedly rejected"
            allowWriterExit.Wait()
        finally
            rootLock.ExitWriteLock())

check (writerEntered.Wait(1000)) "Atomic publication must acquire the root writer"
let waitingReader = Task.Run(fun () -> snapshot ())
check (not (waitingReader.Wait(50))) "Reader must wait rather than observe a partial publication"
allowWriterExit.Set()
publishTask.GetAwaiter().GetResult()
let afterPublish = waitingReader.GetAwaiter().GetResult()
check (afterPublish.Game |> Option.exists (sameReference newGame))
      "Reader must observe the new game after publication"
match afterPublish.Typed with
| SlotB typed -> check (sameReference newGame typed) "Typed and untyped refs must publish atomically"
| _ -> failwith "New publication retained an old typed slot"

// A newer generation discards a prepared candidate without mutating either
// reference, and an incoherent typed/game payload is rejected as a unit.
liveGeneration <- 2L
let staleCandidate = { Generation = 1L; Game = Some staleGame; Typed = SlotA staleGame }
rootLock.EnterWriteLock()
try
    match publishIfCurrent liveGeneration staleCandidate with
    | Some next -> published <- next
    | None -> ()
finally
    rootLock.ExitWriteLock()
let afterStale = snapshot ()
check (afterStale.Game |> Option.exists (sameReference newGame))
      "Stale generation must not replace the current game"
match afterStale.Typed with
| SlotB typed -> check (sameReference newGame typed) "Stale generation must not replace the typed slot"
| _ -> failwith "Stale generation changed the typed slot"

let incoherent = { Generation = 2L; Game = Some staleGame; Typed = SlotA newGame }
check ((publishIfCurrent liveGeneration incoherent).IsNone)
      "Mismatched typed and untyped references must be rejected"

// Source contract: production preparation contains no global model assignment;
// publication owns all typed/game assignment and follow-up stays outside it.
let source = File.ReadAllText(Path.Combine(__SOURCE_DIRECTORY__, "Program.fs"))
let between (startMarker: string) (endMarker: string) =
    let startIndex = source.IndexOf(startMarker, StringComparison.Ordinal)
    let endIndex = source.IndexOf(endMarker, startIndex, StringComparison.Ordinal)
    check (startIndex >= 0 && endIndex > startIndex) (sprintf "Missing source segment %s" startMarker)
    source.Substring(startIndex, endIndex - startIndex)

let preparationSource = between "    let prepareWorkspace " "    /// Atomically replace"
for forbiddenAssignment in
    [ "gameObj <-"; "stlGameObj <-"; "hoi4GameObj <-"; "eu4GameObj <-"
      "ck2GameObj <-"; "irGameObj <-"; "vic2GameObj <-"; "ck3GameObj <-"
      "vic3GameObj <-"; "eu5GameObj <-"; "customGameObj <-"; "activeGame <-" ] do
    check (not (preparationSource.Contains(forbiddenAssignment, StringComparison.Ordinal)))
          (sprintf "Detached preparation must not assign %s" forbiddenAssignment)

let publicationSource = between "    let publishPreparedWorkspace " "    let completePreparedWorkspacePublication "
for requiredAssignment in [ "gameFieldClearers"; "gameObj <- prepared.game"; "stlGameObj <- Some game"; "customGameObj <- Some game" ] do
    check (publicationSource.Contains(requiredAssignment, StringComparison.Ordinal))
          (sprintf "Atomic publication must retain %s" requiredAssignment)
for forbiddenFollowup in [ "CustomNotification"; "PublishDiagnostics"; "sendDiagnostics"; "CleanupCache"; "logInfo" ] do
    check (not (publicationSource.Contains(forbiddenFollowup, StringComparison.Ordinal)))
          (sprintf "Publication callback must exclude %s follow-up" forbiddenFollowup)

let processSource = between "    let processWorkspace" "    let rulesUpdateIsCurrent "
for normalStartupStep in [ "prepareWorkspace uri"; "publish prepared"; "completePreparedWorkspacePublication published" ] do
    check (processSource.Contains(normalStartupStep, StringComparison.Ordinal))
          (sprintf "Normal startup must retain %s" normalStartupStep)
check (processSource.Contains("| None -> prepareWorkspace uri", StringComparison.Ordinal))
      "Detached processWorkspace mode must return preparation without UI/publication"

printfn "WorkspacePublication tests passed"
