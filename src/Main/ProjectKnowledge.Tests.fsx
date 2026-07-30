#r "../../artifacts/bin/Main/debug/CWTools Server.dll"

open System
open System.IO
open Main.ProjectKnowledge

let private assertTrue name condition =
    if not condition then failwith $"{name}: expected true"

let private assertFalse name condition =
    if condition then failwith $"{name}: expected false"

let outgoingSource, outgoingTarget = orientTypedReference "kuat_legacy.38" "kuat_legacy.39" true
let incomingSource, incomingTarget = orientTypedReference "container_event" "referenced_event" false
assertTrue "outgoing typed reference preserves source-to-target direction" (outgoingSource = "kuat_legacy.38" && outgoingTarget = "kuat_legacy.39")
assertTrue "incoming typed reference reverses target-to-source direction" (incomingSource = "referenced_event" && incomingTarget = "container_event")

let root =
    Path.Combine(Path.GetTempPath(), "cwtools-project-knowledge-temp-cleanup-" + Guid.NewGuid().ToString("N"))

Directory.CreateDirectory(root) |> ignore

try
    let target = Path.Combine(root, "knowledge.sqlite")
    File.WriteAllText(target, "published")

    let abandonedLegacy = target + ".tmp-" + Guid.NewGuid().ToString("N")
    let recentLegacy = target + ".tmp-" + Guid.NewGuid().ToString("N")
    let abandonedOwned =
        target + ".tmp-" + Int32.MaxValue.ToString() + "-" + Guid.NewGuid().ToString("N")
    let liveOwned =
        target + ".tmp-" + Environment.ProcessId.ToString() + "-" + Guid.NewGuid().ToString("N")
    let unrelated = Path.Combine(root, "unrelated.tmp-" + Guid.NewGuid().ToString("N"))

    for file in [ abandonedLegacy; recentLegacy; abandonedOwned; liveOwned; unrelated ] do
        File.WriteAllText(file, "temporary")

    File.SetLastWriteTimeUtc(abandonedLegacy, DateTime.UtcNow.AddHours(-2.0))
    File.SetLastWriteTimeUtc(liveOwned, DateTime.UtcNow.AddHours(-2.0))

    cleanupStaleKnowledgeTemporaryFiles target

    assertFalse "old legacy temporary database is removed" (File.Exists abandonedLegacy)
    assertTrue "recent legacy temporary database is retained" (File.Exists recentLegacy)
    assertFalse "temporary database owned by a dead process is removed" (File.Exists abandonedOwned)
    assertTrue "temporary database owned by this live process is retained" (File.Exists liveOwned)
    assertTrue "published database is retained" (File.Exists target)
    assertTrue "unrelated temporary file is retained" (File.Exists unrelated)
finally
    Directory.Delete(root, true)

printfn "ProjectKnowledge temporary database cleanup regression tests passed"
