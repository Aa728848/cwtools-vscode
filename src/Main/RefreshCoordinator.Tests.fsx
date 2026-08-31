#load "RefreshCoordinator.fs"

open System
open System.Collections.Concurrent
open System.Threading.Tasks
open RefreshCoordinator

let check condition message = if not condition then failwith message
let equal expected actual message = if expected <> actual then failwithf "%s. Expected %A, got %A" message expected actual
let run = function Run ticket -> ticket | Idle -> failwith "Expected Run"
let idle = function Idle -> () | Run _ -> failwith "Expected Idle"
let throws<'T when 'T :> exn> action message =
    try action (); failwith (message + ": no exception")
    with :? 'T -> ()

// N+1 survives completion of N, and mixed identities keep exact snapshots.
let coordinator = Coordinator<string>()
let n = coordinator.Request "a" |> run
coordinator.Request "a" |> idle
coordinator.Request "b" |> idle
let next = coordinator.Complete n |> run
check (next.Identity = "b" && next.Generation = n.Generation + 2L) "Newest wake must survive N"
check (next.IdentityGeneration = 1L) "Identity generations must be independent"
check (not (coordinator.IsCurrent n)) "Superseded identity ticket must be stale"
check (coordinator.IsCurrent next) "Newest mixed ticket must be current"
coordinator.Complete next |> idle

// Freshness and identity generation are per identity, not global-generation aliases.
let freshness = Coordinator<string>()
let a1 = freshness.Request "A" |> run
freshness.Complete a1 |> idle
let b1 = freshness.Request "B" |> run
check (freshness.IsCurrent a1) "Requesting B must not stale latest A"
check (freshness.IsCurrent b1) "B1 must be current"
equal 1L a1.IdentityGeneration "A first identity generation"
equal 1L b1.IdentityGeneration "B first identity generation"
freshness.Complete b1 |> idle
let a2 = freshness.Request "A" |> run
check (not (freshness.IsCurrent a1)) "A2 must stale A1"
check (freshness.IsCurrent b1) "A2 must not stale latest B"
equal 2L a2.IdentityGeneration "A generation advances independently"
equal 1L b1.IdentityGeneration "B generation remains independent"
freshness.Complete a2 |> idle

// A foreign issued capability cannot consume an active wake, and rejection preserves state.
let protectedCoordinator = Coordinator<string>()
let protectedRunning = protectedCoordinator.Request "running" |> run
protectedCoordinator.Request "wake" |> idle
let foreignCoordinator = Coordinator<string>()
let foreign = foreignCoordinator.Request "running" |> run
check (foreign.Identity = protectedRunning.Identity
       && foreign.Generation = protectedRunning.Generation
       && foreign.IdentityGeneration = protectedRunning.IdentityGeneration
       && foreign.Epochs = protectedRunning.Epochs) "Foreign ticket fields must match own ticket"
check (protectedCoordinator.IsCurrent protectedRunning) "Own matching ticket must be current"
check (not (protectedCoordinator.IsCurrent foreign)) "Foreign matching ticket must not be current"
throws<ArgumentException> (fun () -> protectedCoordinator.Complete foreign |> ignore) "Foreign capability rejected"
let protectedWake = protectedCoordinator.Complete protectedRunning |> run
equal "wake" protectedWake.Identity "Rejected capability must preserve wake"
protectedCoordinator.Complete protectedWake |> idle
foreignCoordinator.Complete foreign |> idle

// A previously issued stale capability cannot consume or replace a queued wake.
let staleCoordinator = Coordinator<string>()
let stale = staleCoordinator.Request "A" |> run
staleCoordinator.Complete stale |> idle
let current = staleCoordinator.Request "B" |> run
staleCoordinator.Request "A" |> idle
throws<ArgumentException> (fun () -> staleCoordinator.Complete stale |> ignore) "Stale capability rejected"
let preservedWake = staleCoordinator.Complete current |> run
equal "A" preservedWake.Identity "Stale rejection must preserve exact queued wake"
staleCoordinator.Complete preservedWake |> idle

// Clear changes the complete epoch vector and discards a queued wake.
let beforeClear = coordinator.Request "clear" |> run
coordinator.Request "queued" |> idle
coordinator.Clear "workspace"
check (not (coordinator.IsCurrent beforeClear)) "Clear must stale captured epochs"
coordinator.Complete beforeClear |> idle
let afterClear = coordinator.Request "clear" |> run
check (afterClear.Epochs = Map [ ("workspace", 1L) ]) "Ticket must capture exact epoch vector"
coordinator.Complete afterClear |> idle

// Null is rejected explicitly; empty identities and epoch names are valid keys.
throws<ArgumentNullException> (fun () -> Coordinator<string>().Request null |> ignore) "Null identity rejected"
let edge = Coordinator<string>()
let emptyIdentity = edge.Request "" |> run
equal "" emptyIdentity.Identity "Empty identity retained"
edge.Complete emptyIdentity |> idle
throws<ArgumentNullException> (fun () -> edge.Clear null) "Null epoch name rejected"
edge.Clear ""
equal (Map [ ("", 1L) ]) (edge.SnapshotEpochs()) "Empty epoch name retained"
check (not (edge.IsCurrent Unchecked.defaultof<Ticket<string>>)) "Null ticket is not current"
throws<ArgumentNullException> (fun () -> edge.Complete Unchecked.defaultof<Ticket<string>> |> ignore) "Null completion rejected"

// Failure is represented by completing the same exact ticket in a finally block.
let failureCoordinator = Coordinator<int>()
let failed = failureCoordinator.Request 1 |> run
try raise (InvalidOperationException "worker failed")
with :? InvalidOperationException -> failureCoordinator.Complete failed |> idle
let recovered = failureCoordinator.Request 2 |> run
check (recovered.Identity = 2) "Failure completion must release running slot"
failureCoordinator.Complete recovered |> idle

// Concurrent requests produce unique sequencing, one runner, and the newest final wake.
let concurrent = Coordinator<int>()
let results = ConcurrentBag<Completion<int>>()
Parallel.For(0, 256, fun i -> results.Add(concurrent.Request(i % 37))) |> ignore
let immediate = results |> Seq.choose (function Run t -> Some t | Idle -> None) |> Seq.toArray
check (immediate.Length = 1) "Exactly one concurrent request may start"
let wake = concurrent.Complete immediate[0] |> run
equal 256L wake.Generation "One wake must retain newest concurrent ticket"
check (concurrent.IsCurrent wake) "Final concurrent wake must be current"
check (wake.Identity >= 0 && wake.Identity < 37) "Concurrent identity must be retained"
concurrent.Complete wake |> idle

// Many identities retain independent freshness after concurrent activity.
let identities = Coordinator<int>()
let latest =
    [| for identity in 0 .. 63 do
           let ticket = identities.Request identity |> run
           identities.Complete ticket |> idle
           yield ticket |]
check (latest |> Array.forall identities.IsCurrent) "Latest ticket for every identity must remain current"
let replacement = identities.Request 31 |> run
check (not (identities.IsCurrent latest[31])) "Replacement must stale only its identity"
check (latest |> Array.mapi (fun i ticket -> i = 31 || identities.IsCurrent ticket) |> Array.forall id) "Other identities remain current"
identities.Complete replacement |> idle

// Production wake decisions are explicit and game identity is reference-based.
equal false (needsWake Idle) "Idle does not require mailbox wake"
let wakeDecision = Coordinator<string>()
let wakeRunning = wakeDecision.Request "game" |> run
equal true wakeDecision.IsRunning "Coordinator reports running work"
wakeDecision.Request "game" |> idle
equal true wakeDecision.NeedsWake "Coordinator reports queued wake"
let wakeFollowUp = wakeDecision.Complete wakeRunning
equal true (needsWake wakeFollowUp) "Queued refresh requires mailbox wake"
match wakeFollowUp with Run ticket -> wakeDecision.Complete ticket |> idle | Idle -> failwith "Expected wake ticket"
let gameA = obj ()
let gameAlias = gameA
let gameB = obj ()
equal true (sameGameIdentity gameA gameAlias) "Same live game reference accepted"
equal false (sameGameIdentity gameA gameB) "Replacement game reference rejected"

// Invalid/stale completion is visible and never silently swallowed.
throws<InvalidOperationException> (fun () -> concurrent.Complete wake |> ignore) "Completion without runner rejected"

printfn "RefreshCoordinator tests passed"
