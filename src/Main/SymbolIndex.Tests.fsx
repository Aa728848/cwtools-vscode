#load "../TestHelpers.fsx"
#load "SymbolIndex.fs"

open System
open System.Threading
open System.Threading.Tasks
open SymbolIndex
open TestHelpers
let p l c = { Line = l; Character = c }
let r sl sc el ec = { Start = p sl sc; End = p el ec }
let s name range = { Name = name; Kind = 1; Range = range; SelectionRange = range; Detail = None }

let corpus = documentCorpus [ s "child" (r 1 0 2 0); s "root" (r 0 0 5 0); s "peer" (r 6 0 7 0) ]
equal ["root"; "peer"] (corpus |> List.map (fun x -> x.Symbol.Name)) "deterministic roots"
equal ["child"] (corpus.Head.Children |> List.map (fun x -> x.Symbol.Name)) "range nesting"
let equalRanges = documentCorpus [s "z-first" (r 0 0 3 0); s "a-second" (r 0 0 3 0)]
equal "z-first" equalRanges.Head.Symbol.Name "equal ranges preserve input order"
equal ["a-second"] (equalRanges.Head.Children |> List.map (fun x -> x.Symbol.Name)) "equal ranges nest in input order"

let epochs = EpochCache<string, int>(2)
epochs.Set("a", 1); epochs.Set("a", 2); epochs.Set("a", 3)
equal 1 epochs.Count "one live value per key"
equal 1 epochs.OrderingNodeCount "one ordering node per live key"
epochs.Set("b", 2); epochs.Set("c", 3)
equal None (epochs.TryGet "a") "bounded eviction"
equal (Some 3) (epochs.TryGet "c") "newest retained"
equal epochs.Count epochs.OrderingNodeCount "strict total bound"
epochs.Advance() |> ignore
equal None (epochs.TryGet "c") "epoch invalidation"
equal 0 epochs.OrderingNodeCount "advance clears ordering nodes"

let hits = workspaceCorpus "foo" [ "b", [s "xfoo" (r 0 0 0 1)]; "a", [s "Foo" (r 0 0 0 1); s "foobar" (r 1 0 1 1); s "Foo" (r 0 0 0 1)] ]
equal ["Foo"; "foobar"; "xfoo"] (hits |> List.map (fun x -> x.Symbol.Name)) "ranking and dedupe"
let ties = workspaceCorpus "x" ["b", [s "x" (r 0 0 0 1)]; "a", [s "x" (r 0 0 0 1)]]
equal ["a"; "b"] (ties |> List.map _.File) "deterministic tie break"
equal 200 (workspaceCorpus "" [("a", seq { for i in 1..250 -> s (string i) (r i 0 i 1) })] |> List.length) "top 200"

let cache = SingleFlightCache<string, int>(128)
let first = TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously)
let mutable calls = 0
let a = cache.Get("a", fun () -> calls <- calls + 1; first.Task)
let same = cache.Get("a", fun () -> calls <- calls + 1; Task.FromResult 9)
equal true (Object.ReferenceEquals(a, same)) "single flight"
equal 1 calls "one factory"
let abaSource = TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously)
let abaCache = SingleFlightCache<string, int>(2)
let abaA = abaCache.Get("a", fun () -> abaSource.Task)
let abaB = abaCache.Get("b", fun () -> Task.FromResult 2)
let abaAAgain = abaCache.Get("a", fun () -> Task.FromResult 99)
equal true (Object.ReferenceEquals(abaA, abaAAgain)) "A-B-A joins the original active A flight"
abaSource.SetResult 1
equal 1 abaAAgain.Result "A-B-A returns the original A result"
equal 2 abaB.Result "independent B result"
let newerSource = TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously)
let newer = cache.Get("b", fun () -> newerSource.Task)
first.SetResult 1
a.GetAwaiter().GetResult() |> ignore
let b2 = cache.Get("b", fun () -> Task.FromResult 3)
equal true (Object.ReferenceEquals(newer, b2)) "incomplete newer key survives stale completion"
newerSource.SetResult 2
equal 2 newer.Result "newer result"
equal true (Object.ReferenceEquals(newer, cache.Get("b", fun () -> Task.FromResult 4))) "successful value stays cached"

let outsideMonitor = SingleFlightCache<string, int>(128)
let entered = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
let release = TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously)
let producer: Task<Task<int>> = Task.Run<Task<int>>(fun () -> outsideMonitor.Get("a", fun () -> entered.SetResult(); release.Task))
entered.Task.Wait()
let other: Task<Task<int>> = Task.Run<Task<int>>(fun () -> outsideMonitor.Get("b", fun () -> Task.FromResult 2))
equal true (other.Wait(1000)) "factory runs outside monitor"
release.SetResult 1
producer.Result.Result |> ignore

let overflowCache = SingleFlightCache<string, int>(1)
let activeRelease = TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously)
let active = overflowCache.Get("active", fun () -> activeRelease.Task)
let overflowEntered = TaskCompletionSource<unit>(TaskCreationOptions.RunContinuationsAsynchronously)
let overflowRelease = TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously)
let overflow: Task<Task<int>> =
    Task.Run<Task<int>>(fun () ->
        overflowCache.Get("overflow", fun () ->
            equal true (Object.ReferenceEquals(active, overflowCache.Get("active", fun () -> Task.FromResult 99))) "overflow factory can reenter cache"
            overflowEntered.SetResult()
            overflowRelease.Task))
equal false (overflowEntered.Task.Wait(100)) "overflow factory waits for active capacity"
activeRelease.SetResult 1
equal 1 active.Result "active result"
equal true (overflowEntered.Task.Wait(1000)) "overflow factory starts after capacity release"
let unrelated: Task<Task<int>> = Task.Run<Task<int>>(fun () -> overflowCache.Get("unrelated", fun () -> Task.FromResult 3))
equal true (unrelated.Wait(1000)) "overflow get returns a non-blocking admission task"
equal false (unrelated.Result.Wait(100)) "second overflow waits while admitted overflow is active"
overflowRelease.SetResult 2
equal 2 overflow.Result.Result "overflow result"
equal 3 unrelated.Result.Result "unrelated overflow progresses after release"

let canceledOverflowCache = SingleFlightCache<string, int>(1)
let canceledActiveRelease = TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously)
let canceledActive = canceledOverflowCache.Get("active", fun () -> canceledActiveRelease.Task)
let overflowCancellation = new CancellationTokenSource()
let canceledOverflowFactoryCalled = ref false
let canceledOverflow =
    canceledOverflowCache.Get("overflow", (fun () -> canceledOverflowFactoryCalled.Value <- true; Task.FromResult 2), overflowCancellation.Token)
overflowCancellation.Cancel()
throws<TaskCanceledException> (fun () -> canceledOverflow.GetAwaiter().GetResult() |> ignore) "overflow admission cancellation propagates"
equal false canceledOverflowFactoryCalled.Value "canceled overflow never starts factory"
canceledActiveRelease.SetResult 1
equal 1 canceledActive.Result "canceled overflow does not disturb active flight"
equal 3 (canceledOverflowCache.Get("after", fun () -> Task.FromResult 3).Result) "capacity remains usable after canceled overflow"

let retry = SingleFlightCache<string, int>(128)
let faulted = retry.Get("fault", fun () -> Task.FromException<int>(InvalidOperationException("fault")))
throws<InvalidOperationException> (fun () -> faulted.GetAwaiter().GetResult() |> ignore) "fault propagation"
equal 7 (retry.Get("fault", fun () -> Task.FromResult 7).Result) "fault evicted"
let canceled = retry.Get("cancel", fun () -> Task.FromCanceled<int>(CancellationToken(true)))
throws<TaskCanceledException> (fun () -> canceled.GetAwaiter().GetResult() |> ignore) "cancel propagation"
equal 8 (retry.Get("cancel", fun () -> Task.FromResult 8).Result) "cancel evicted"
let synchronous = retry.Get("sync", fun () -> raise (ArgumentException("sync")))
throws<ArgumentException> (fun () -> synchronous.GetAwaiter().GetResult() |> ignore) "sync exception propagation"
equal 9 (retry.Get("sync", fun () -> Task.FromResult 9).Result) "sync exception evicted"
let nullTask = retry.Get("null", fun () -> null)
throws<InvalidOperationException> (fun () -> nullTask.GetAwaiter().GetResult() |> ignore) "null task rejected"
equal 10 (retry.Get("null", fun () -> Task.FromResult 10).Result) "null evicted"
retry.Clear()
equal 11 (retry.Get("null", fun () -> Task.FromResult 11).Result) "clear evicts success"

let mutable modelEpoch = 1L
let fresh = SingleFlightCache<int64 * string, string>(128)
let oldBuild = TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously)
let mutable oldBuilds = 0
let mutable newBuilds = 0
let request () =
    getFreshSingleFlight 2 (fun () -> Interlocked.Read(&modelEpoch)) fresh "file.txt" (fun epoch ->
        if epoch = 1L then oldBuilds <- oldBuilds + 1; oldBuild.Task
        else newBuilds <- newBuilds + 1; Task.FromResult(sprintf "epoch-%d" epoch))
let staleRequest = request ()
let staleJoin = request ()
equal 1 oldBuilds "concurrent document misses share one old build"
Interlocked.Exchange(&modelEpoch, 2L) |> ignore
let currentRequest = request ()
equal "epoch-2" currentRequest.Result "new epoch request returns new corpus"
oldBuild.SetResult "epoch-1"
equal "epoch-2" staleRequest.Result "stale build retries instead of returning stale corpus"
equal "epoch-2" staleJoin.Result "stale concurrent waiter retries to current corpus"
equal 1 oldBuilds "old epoch built once"
equal 1 newBuilds "new epoch built once"
equal "epoch-2" (request().Result) "old completion never evicts newer corpus"
equal 1 newBuilds "new corpus remains cached"

let bounded = EpochCache<int64 * string, int>(256)
for index in 1 .. 600 do bounded.Set((1L, sprintf "type-%d" index), index)
equal 256 bounded.Count "distinct type-reference queries stay bounded"
equal None (bounded.TryGet(1L, "type-1")) "old type-reference result evicted"
equal (Some 600) (bounded.TryGet(1L, "type-600")) "new type-reference result retained"
bounded.Advance() |> ignore
equal 0 bounded.Count "type-reference clear semantics"

printfn "SymbolIndex tests passed"
