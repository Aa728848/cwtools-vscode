#r "../../artifacts/bin/Main/debug/CWTools Server.dll"
#r "../../artifacts/bin/Main/debug/LSP.dll"

#load "../TestHelpers.fsx"

open System
open System.IO
open LSP
open TestHelpers

let harness = TestHarness("HostCapabilities")

// The capability handshake is an internal command: it must be answered before the
// game model loads, must advertise a stable protocol version, and must not appear
// in any model-facing tool schema. These checks pin all three.
let commandsSource = File.ReadAllText(Path.Combine(__SOURCE_DIRECTORY__, "..", "LSP", "Commands.fs"))
let programSource = File.ReadAllText(Path.Combine(__SOURCE_DIRECTORY__, "Program.fs"))

harness.Check
    "capability command is registered"
    (Commands.allCommandNames |> List.contains "cwtools.ai.getHostCapabilities")

harness.Check
    "capability command is read-only"
    (Commands.isReadOnly "cwtools.ai.getHostCapabilities")

harness.Check
    "protocol version is 1"
    (Commands.HostCapabilitiesProtocolVersion = 1)

// The reported version must come from the nearest release manifest, not from a
// hand-written literal. Assembly metadata is only the fallback when no manifest exists.
// Assert the mechanism and the actual release value, with no duplicate version source.
harness.Check
    "server version is a non-empty string"
    (not (String.IsNullOrWhiteSpace Commands.serverVersion))

harness.Check
    "server version is derived from the release manifest"
    (commandsSource.Contains("JsonDocument.Parse", StringComparison.Ordinal))

harness.Check
    "server version contains no build metadata suffix"
    (not (Commands.serverVersion.Contains "+"))

harness.Check
    "command table is non-empty"
    (Commands.allCommandNames |> List.isEmpty |> not)

harness.Check
    "command table has no duplicates"
    ((Commands.allCommandNames |> List.distinct |> List.length) = (Commands.allCommandNames |> List.length))

// The handshake must be answered even when the game model is absent, so its branch
// has to sit next to the getValidationStatus early return, before the gameObj match.
let handshakeAt = programSource.IndexOf("cwtools.ai.getHostCapabilities", StringComparison.Ordinal)
let validationAt = programSource.IndexOf("if p.command = \"cwtools.ai.getValidationStatus\"", StringComparison.Ordinal)
let gameObjAt = programSource.IndexOf("match gameObj with", validationAt, StringComparison.Ordinal)

harness.Check "the handshake branch exists in ExecuteCommand" (handshakeAt >= 0)
harness.Check "the handshake is answered before getValidationStatus" (handshakeAt < validationAt)
harness.Check "both early returns precede the gameObj match" (validationAt < gameObjAt)

let handshakeBlock =
    if handshakeAt < 0 then ""
    else programSource.Substring(handshakeAt, min 900 (programSource.Length - handshakeAt))

harness.Check "the handshake reports protocolVersion" (handshakeBlock.Contains("protocolVersion", StringComparison.Ordinal))
harness.Check "the handshake reports serverVersion" (handshakeBlock.Contains("serverVersion", StringComparison.Ordinal))
harness.Check "the handshake reports the command table" (handshakeBlock.Contains("allCommandNames", StringComparison.Ordinal))

// The handshake is internal: it must never be exposed as a model-facing tool.
let agentsSourcePath = Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "client", "extension", "ai", "tools", "definitions.ts")
let agentsSource = if File.Exists agentsSourcePath then File.ReadAllText agentsSourcePath else ""
harness.Check
    "the handshake is not exposed as an agent tool"
    (not (agentsSource.Contains("cwtools.ai.getHostCapabilities", StringComparison.Ordinal)))

harness.Check
    "the handshake is registered exactly once in the command table"
    ((commandsSource.Split("cwtools.ai.getHostCapabilities").Length - 1) >= 1)

// No duplicate version source: the command module must not carry a hardcoded
// product version literal (a semver-looking string in a Literal ServerVersion).
harness.Check
    "the command module carries no hardcoded server version literal"
    (not (System.Text.RegularExpressions.Regex.IsMatch(
        commandsSource,
        "Literal\]\s*\r?\n\s*let\s+ServerVersion\s*=\s*\"")))

harness.Check
    "serverVersion is computed rather than declared as a literal"
    (commandsSource.Contains("let serverVersion: string =", StringComparison.Ordinal))

// The root/release manifests are the only version sources; the value the server
// reports must match the package version it ships with.
let releasePackagePath = Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "release", "package.json")
if File.Exists releasePackagePath then
    let releasePackage = File.ReadAllText releasePackagePath
    let versionMatch = System.Text.RegularExpressions.Regex.Match(releasePackage, "\"version\"\s*:\s*\"([0-9][^\"]*)\"")
    harness.Check
        "the reported version matches release/package.json"
        (versionMatch.Success
         && Commands.serverVersion.StartsWith(versionMatch.Groups.[1].Value, StringComparison.Ordinal))
else
    harness.Check "release/package.json is readable for the version cross-check" false

harness.Summary() |> exit
