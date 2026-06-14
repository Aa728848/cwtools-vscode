# cwtools-mcp

MCP server for CWTools semantic modding assistance.

## Shipped inside the VS Code extension

The packaged build is bundled into the extension as a single self-contained file. On
activation the extension also copies it to a **version-independent stable path** in
globalStorage, so external agents can point at a location that keeps following
extension updates without editing the version number:

```
# Stable (recommended — never changes across versions):
<globalStorage>/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs
#   Windows: %APPDATA%/Code/User/globalStorage/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs
#   macOS:   ~/Library/Application Support/Code/User/globalStorage/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs
#   Linux:   ~/.config/Code/User/globalStorage/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs

# Versioned (inside the extension dir, changes each release):
<vscode-extensions>/eddy.eddy-stellaris-cwt-<version>/bin/mcp/cwtools-mcp.cjs
```

External agents run it with `node`. It auto-detects the installed extension's
server binary (`bin/server/<platform>/CWTools Server`), the extracted rules, and
the vanilla cache in globalStorage — so no dev checkout or extra flags are needed.
It is **read-only**: file writes are left to the host agent's own environment.

## Usage

Stdio transport (dev checkout):

```sh
cwtools-mcp --workspace /path/to/mod --game stellaris --stdio
```

Streamable HTTP transport:

```sh
cwtools-mcp --workspace /path/to/mod --game stellaris --http --host 127.0.0.1 --port 3000
```

The HTTP MCP endpoint is `/mcp`; a lightweight health check is available at `/healthz`.

## Vanilla game data

CWTools semantic results combine your mod with the **vanilla game cache**. Without
it, the server still runs, but results are mod-only: vanilla IDs do not appear and
mod references to vanilla definitions are reported as undefined errors. Provide one
of:

```sh
# Build the cache from a vanilla install (slow first run, then cached)
cwtools-mcp --workspace /path/to/mod --game stellaris --game-path "/path/to/Stellaris"

# Reuse a pre-built <game>.cwb cache dir (e.g. the VS Code extension globalStorage/.cwtools)
cwtools-mcp --workspace /path/to/mod --game stellaris --cache "/path/to/.cwtools"
```

`--cache` alone is sufficient when the dir holds both the `<game>.cwb` cache and the
extracted rules (as the VS Code extension globalStorage does); `--game-path` is only
needed to build the cache from scratch.

If neither flag is given, the MCP **auto-detects the VS Code cwtools extension cache**
in globalStorage (`Code`/`Code - Insiders`/`VSCodium`/`Cursor`) and reuses it — so once
you've opened the project in the extension at least once, no cache flag is needed.

When no cache can be found, vanilla-dependent tool results carry
`vanillaCache.available = false` plus a warning so clients never treat a mod-only
answer as complete.

## Rules source

By default the MCP uses the rules the installed extension extracted into globalStorage.
To override, pass `--rules`:

```sh
cwtools-mcp --workspace /path/to/mod --game stellaris --rules /path/to/rules-dir --stdio
cwtools-mcp --workspace /path/to/mod --game stellaris --rules /path/to/stellaris-rules.zip --stdio
```

Priority: `--rules` > installed-extension extracted rules > dev checkout (`submodules/…/config`)
> bundled `*-rules.zip` (auto-extracted). A `.zip` is extracted once into the rules-cache
and reused.

## Using from Codex

Codex reads MCP servers from `~/.codex/config.toml` (`[mcp_servers.<name>]`, shared with
the Codex IDE extension). The quickest way — let Codex add it for you with one command,
pointing at the **stable globalStorage path** (no version number, survives updates):

```sh
codex mcp add cwtools -- node "%APPDATA%/Code/User/globalStorage/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs" --game stellaris --stdio
```

(macOS/Linux: replace the path with the `globalStorage` location for your platform.) You can
also ask Codex itself to run that `codex mcp add …` command. Equivalent manual TOML:

```toml
[mcp_servers.cwtools]
command = "node"
args = [
  "C:/Users/<you>/AppData/Roaming/Code/User/globalStorage/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs",
  "--game", "stellaris",
  "--stdio",
]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

Using the stable globalStorage path means the config never changes when the extension
updates (the extension re-syncs the bundle there on activation). Omit `--workspace` to
analyse the directory Codex launches the server in (its cwd); leave the GUI "working
directory" blank so it follows the open project. Use forward slashes in TOML. Start a
Codex session and run `/mcp` to confirm the server and its 21 read-only tools are
connected — the server also sends `instructions` telling the model when to use them.

Load-dependent results (type/scope/rule/definition/diagnostics queries) carry a
`readiness` field. While the project is still loading they come back with
`status: "loading"` and `readiness.ready = false` instead of a misleading empty
answer — poll until `readiness.ready` is true (a few seconds with a pre-built cache).

Write tools are disabled by default. To enable controlled writes:

```sh
cwtools-mcp --workspace /path/to/mod --enable-writes --allow-tool write_localisation --allow-tool edit_pdx_block
```

If `--enable-writes` is omitted, write tools remain visible but fail closed with a structured denial.

## Tools

The package exposes generated schemas for CWTools read tools, diagnostics, project/profile knowledge, completion and symbol navigation, plus guarded write tools for localisation and PDX block replacement.
